import { WebexClient } from '../api/WebexClient';
import { RealtimeClient } from '../api/RealtimeClient';
import { Localization } from '../i18n';
import { AudioSettingsPanel } from './AudioSettingsPanel';
import { CallManager } from './CallManager';
import { ChatUI } from './ChatUI';

export class ChatWidget extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.threadId = null;
    this.mqtt = new RealtimeClient();
    this.view = 'list'; // 'list' or 'chat'
    this.threads = [];
    this.currentUserId = null;
    this.processedTids = new Set(); // Track message TIDs to prevent duplicates
    this.isOpen = false; // Default to closed (launcher view)
    this.isDark = false;
    this.audioSettingsPanel = new AudioSettingsPanel(this);
    this.callManager = new CallManager(this);
    this.ui = new ChatUI(this, this.shadowRoot);
    this.isLoading = false;
    this.recentQRs = new Set();
    this._openTime = 0;

    this._handleThemeChange = this._handleThemeChange.bind(this);
    this._handleClickOutside = this._handleClickOutside.bind(this);
  }

  async connectedCallback() {
    // Configuration from attributes
    const startMsg = this.getAttribute('start-message') || null;
    const appId = this.getAttribute('app-id') || '';
    const clientKey = this.getAttribute('client-key') || '';
    const accessToken = this.getAttribute('access-token') || this.getAttribute('data-access-token') || '';
    const widgetId = this.getAttribute('widget-id') || this.getAttribute('data-bind') || '';
    const websiteId = this.getAttribute('website-id') || '0'; // Default to 0 if unknown
    const customProfileParams = this.getAttribute('custom-profile-params') || '';
    const websiteDomain = this.getAttribute('website-domain') || '';

    // Store start-message in property to avoid attribute loss issues
    this._startMessage = startMsg;
    this._startMessageHidden = this.hasAttribute('start-message-hidden') && this.getAttribute('start-message-hidden') !== 'false';

    // Fallback: Check sessionStorage if attribute is missing but we might be in a reload
    if (!this._startMessage) {
      try {
        const stored = sessionStorage.getItem('webex-cc-widget-start-message');
        if (stored) {
          this._startMessage = stored;
        }
      } catch (e) { /* ignore */ }
    }

    // Auto-derivation from site-url
    const siteUrlAttr = this.getAttribute('site-url');
    let baseUrl = this.getAttribute('base-url');
    let mqttHost = this.getAttribute('mqtt-host');
    let clientHost = websiteDomain; // Map website-domain to clientHost

    if (siteUrlAttr) {
      try {
        const url = new URL(siteUrlAttr);
        const host = url.hostname; // e.g., ccbootcampsandboxccbcamp1023wbxai.us.webexconnect.io
        const parts = host.split('.');
        const tenant = parts[0];
        const region = parts[1]; // e.g. 'us' or 'eu'

        // 1. Derive Base URL
        if (region === 'us') {
          // If the provided site-url doesn't already have '-usor', inject it for US region sandboxes/instances
          // Pattern: tenant.us.webexconnect.io -> tenant-usor.us.webexconnect.io
          // Check if 'tenant' part already ends with '-usor' (some users might provide full url)
          const apiHost = tenant.endsWith('-usor') ? host : host.replace(tenant, `${tenant}-usor`);

          if (!baseUrl) {
            baseUrl = `https://${apiHost}/rtmsAPI/api/v3`;
          }

          if (!mqttHost) {
            mqttHost = `${tenant}.msg-usor.${region}.webexconnect.io`;
          }
        } else {
          // Fallback attempt or standard pattern if easier
          // For now, try replacing first dot with .msg-usor. ? No.
          // Just default to a pattern or log warning if not 'us'
          // Assuming similar pattern: tenant.msg-{region}or.{region}... ?
          // Safest: Use user provided example logic.
          mqttHost = `${tenant}.msg-usor.${region}.webexconnect.io`;
        }
      } catch (e) {
        console.error('Invalid site-url:', e);
      }
    }

    // Localization
    let lang = this.getAttribute('lang');
    if (!lang) {
      // Auto-detect from browser if not explicitly set
      lang = navigator.language || navigator.userLanguage || 'en';
    }

    // Normalize (e.g. 'cs-CZ' -> 'cs') if strict match not found
    // We'll let the Localization class handle strictly or we do it here.
    // The Localization class currently strictly checks translations[lang].
    // Let's pass the raw detection and handle fallback in i18n or here.
    // Better to handle here to ensure we pass a valid key to constructor if possible, 
    // OR update Localization class to suffice.
    // Let's strip region code here for simplicity as our i18n keys are 2-char.
    if (lang.indexOf('-') > 0) {
      lang = lang.split('-')[0];
    }

    this.i18n = new Localization(lang);
    await this.i18n.setLanguage(lang);

    if (!appId || !clientKey || !baseUrl) {
      console.error('ChatWidget: Missing required attributes (app-id, client-key, base-url).');
      return;
    }

    // Initialize Webex Client
    try {
      await WebexClient.initialize({
        baseUrl,
        appId,
        clientKey,
        accessToken,
        widgetId,
        clientHost,
        websiteId,
        customProfileParams,
        mqttHost
      });
    } catch (error) {
      console.error('Failed to initialize WebexClient:', error);
      return; // Stop further execution if initialization fails
    }

    // Theme Detection
    const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    this.isDark = darkModeQuery.matches;
    darkModeQuery.addEventListener('change', this._handleThemeChange);

    this.render();
    this.init();

    // Add click outside listener (use capture or bubble? 'click' bubbles from document)
    // We attach to document.
    document.addEventListener('click', this._handleClickOutside);

    // Bind Internal Click for Settings Panel
    this._internalClickBound = this._handleInternalClick.bind(this);
    this.shadowRoot.addEventListener('click', this._internalClickBound);
  }

  async init() {
    try {
      this.currentUserId = WebexClient.getUserId();

      // Load existing threads
      await this.loadThreads();

      // 1. Connect to Realtime (MQTT) FIRST to ensure we don't miss welcome messages
      try {
        const mqttCreds = await WebexClient.getMqttCredentials();
        await this.mqtt.connect(mqttCreds);

        // Subscribe to User Topic
        const appId = this.getAttribute('app-id');
        this.mqtt.subscribeToUserTopic(appId, this.currentUserId);
        this.mqtt.onMessage(this.handleMessage.bind(this));
      } catch (mqttErr) {
        console.error('Failed to connect to MQTT:', mqttErr);
        // Continue anyway? Or stop? 
        // If MQTT fails, chat won't work well (no incoming), but we can still fetch history.
      }

      // 2. Check for Auto-Start Condition FIRST
      const startMsg = this.getAttribute('start-message');
      const shouldAutoStart = startMsg && startMsg.trim().length > 0;

      if (shouldAutoStart) {
        console.log('Auto-start detected. Starting immediately...');
        // Start chat immediately (creating new thread)
        await this.startSilentChat(startMsg);
      } else {
        // Show empty state or launcher
        this.render();
      }
    } catch (e) {
      console.error('Init error', e);
    }
  }

  disconnectedCallback() {
    this.removeEventListeners();
    if (this.callManager) {
      this.callManager.disconnect();
    }
    const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    darkModeQuery.removeEventListener('change', this._handleThemeChange);
    document.removeEventListener('click', this._handleClickOutside);
    if (this._internalClickBound) {
      this.shadowRoot.removeEventListener('click', this._internalClickBound);
    }
  }

  removeEventListeners() {
    // Clean up helper if implemented, else safe to remove
  }

  _handleThemeChange(e) {
    this.isDark = e.matches;
    this.ui.updateTheme(this.isDark);
  }

  _handleClickOutside(e) {
    // Ignore clicks immediately after opening (race condition with bubbling triggers)
    if (this.isOpen && e.target !== this) {
      if (Date.now() - this._openTime < 100) {
        return;
      }
      this.toggle();
    }
  }

  _handleInternalClick(e) {
    const panel = this.shadowRoot.querySelector('#audio-settings-panel');
    if (panel && panel.classList.contains('visible')) {
      const path = e.composedPath();
      const isInside = path.includes(panel);
      // Also ignore clicks on the toggle button itself (id='btn-audio-settings')
      // Note: toggle button might be inside call-controls which are in shadowRoot too.
      const isToggleBtn = path.some(el => el.id === 'btn-audio-settings');

      if (!isInside && !isToggleBtn && this.audioSettingsPanel) {
        this.audioSettingsPanel.toggle(); // Close it
      }
    }
  }

  // Helper moved to ChatUI but kept here logic might be useful? No, migrated.

  toggle() {
    this.isOpen = !this.isOpen;
    if (this.isOpen) {
      this._openTime = Date.now();
      // Ensure input gets focus when opening
      if (this.ui) {
        // Slight delay to allow animation/rendering
        setTimeout(() => {
          if (this.ui.focusInput) this.ui.focusInput();
        }, 100);
      }
    }
    this.render();
    // Fix: If opening back into an active chat, re-initialize it to load history
    if (this.isOpen && this.view === 'chat' && this.activeThreadId) {
      this.openChat(this.activeThreadId);
    }
  }

  async startSilentChat(message) {
    // Force open
    this.isOpen = true;
    this.view = 'chat'; // Set view immediately to prevent flash of list
    this.isLoading = true; // Show spinner
    this._openTime = Date.now();
    this.render();

    try {
      // 1. Create New Thread
      const newThread = await WebexClient.createThread();
      if (newThread && newThread.id) {
        this.threads.unshift(newThread);

        // Update stored start message for suppression logic
        if (message) {
          this._startMessage = message;
          this.setAttribute('start-message', message); // Attempt attribute sync
          try {
            sessionStorage.setItem('webex-cc-widget-start-message', message);
          } catch (e) { /* ignore storage errors */ }
        }

        // Use standard openChat to ensure event listeners and focus work
        await this.openChat(newThread.id);

        // 2. Send Message (Visible or Hidden based on config)
        // const hidden = this.hasAttribute('start-message-hidden') && this.getAttribute('start-message-hidden') !== 'false';
        const hidden = this._startMessageHidden; // Use stored prop
        console.log('Auto-starting chat. Message:', message, 'Hidden:', hidden);

        if (hidden) {
          this._awaitingHiddenStart = true;
        }

        // Pass 'hidden' as skipUI param (4th arg) and add metadata
        const extras = hidden ? { extras: { hiddenStart: true } } : {};
        await this.sendMessage(message, null, extras, hidden);
      } else {
        console.error('Failed to create thread for auto-start');
      }

    } catch (e) {
      console.error('Auto-start failed', e);
    } finally {
      this.isLoading = false;
      this.render();
    }
  }

  trackQRClick(text) {
    if (!text) return;
    const normalized = text.trim().toLowerCase();
    console.log('[Debug] Tracking QR Click:', normalized);
    this.recentQRs.add(normalized);
    setTimeout(() => {
      this.recentQRs.delete(normalized);
    }, 5000); // Keep for 5 seconds
  }

  async loadThreads() {
    this.isLoading = true;
    this.render();
    try {
      const threads = await WebexClient.fetchThreads();
      if (threads && Array.isArray(threads)) {
        // Sort by updated/created desc
        this.threads = threads.sort((a, b) => {
          const tA = new Date(a.updated || a.created).getTime();
          const tB = new Date(b.updated || b.created).getTime();
          return tB - tA;
        });
        console.log('Loaded threads:', this.threads.length);
      }
    } catch (e) {
      console.error('Failed to load threads', e);
    } finally {
      this.isLoading = false;
      this.render();
      this.fetchThreadPreviews();
    }
  }

  async fetchThreadPreviews() {
    if (this.threads && this.threads.length > 0) {
      // Use map to process in parallel but handle failures gracefully
      await Promise.allSettled(this.threads.map(async (t) => {
        if (!t.last_message) {
          try {
            const msgs = await WebexClient.fetchHistory(t.id);
            if (msgs && msgs.length > 0) {
              // Assuming msgs[0] is newest. Webex APIs usually return newest first or we need to check sorting.
              // If it's paginated, usually it's newest first.
              const last = msgs[0];
              const txt = last.message || (last.event && last.event.message && last.event.message.text) || (last.media ? 'Attachment' : 'Message');
              t.last_message = txt;
              // Re-render to show preview
              this.render();
            }
          } catch (e) {
            // Ignore individual failures
          }
        }
      }));
    }
  }

  render() {
    if (!this.ui) {
      return;
    }
    this.ui.render(this.isOpen, this.view, this.isDark, this.threads, this.isLoading);
  }

  // ... (Methods delegated from ChatUI callback)

  handleMessage(msg, isHistory = false) {
    console.log('Handling message', msg, isHistory ? '(History)' : '');

    // 0. System Events (Typing, Assigned)
    if (this.handleSystemEvent(msg)) return;

    // Clear typing if a real message arrives
    if ((msg.message || msg.media) && !msg.outgoing) {
      this.ui.hideTyping();
    }

    const text = msg.message || (msg.event && msg.event.message && msg.event.message.text);
    const media = msg.media; // Array of media objects
    const tid = msg.tid || (msg.event && msg.event.tid);

    // Check for Conversation End
    if (msg.payload_type === 'closeThread' || (msg.thread && msg.thread.status === 'Closed')) {
      this.endConversation();
      // We might still want to render the system message if there is one, or just our local one.
      // Usually closeThread comes with an event but maybe no displayable text.
    }

    if (text || (media && media.length > 0)) {

      // Deduplication for real-time messages (tid check)
      if (!isHistory) {
        if (!tid) {
          // console.warn('Message missing TID, rendering anyway but dedupe might fail', msg);
        } else if (this.processedTids.has(tid)) {
          console.warn('Duplicate message ignored:', tid);
          return;
        }
      }

      // Determine outgoing flag
      let isOutgoing = msg.outgoing === true;

      // Secondary check: if payload_type is explicitly sentByUser
      if (!isOutgoing && msg.payload_type === 'sentByUser') {
        isOutgoing = true;
      }

      // Logic to suppress Hidden Start Message (Live & History)
      const isHiddenStart = (msg.extras && msg.extras.hiddenStart) ||
        (msg.extras && msg.extras.context && msg.extras.context.hiddenStart);

      console.log('[Debug] Checking suppression. Text:', text, 'HiddenStart Metadata:', isHiddenStart, 'Extras:', JSON.stringify(msg.extras));
      console.log('[Debug] Fallback check. StartMsgHidden:', this._startMessageHidden, 'Exp:', this._startMessage);

      if (isHiddenStart) {
        if (!isHistory && this._awaitingHiddenStart) {
          this._awaitingHiddenStart = false;
        }
        return;
      }

      // Legacy text-match fallback (for older messages or if metadata missing)
      if (this._startMessageHidden && text) {
        const normalized = text.trim().toLowerCase();
        let expected = (this._startMessage || '').trim().toLowerCase();

        // JIT Fallback: If local property is missing, try storage again
        if (!expected) {
          try {
            const stored = sessionStorage.getItem('webex-cc-widget-start-message');
            if (stored) {
              this._startMessage = stored;
              expected = stored.trim().toLowerCase();
            }
          } catch (e) { }
        }

        // Check if this message matches the start message
        if (expected && normalized === expected) {

          // If it's a live message, we also update the state
          if (!isHistory && this._awaitingHiddenStart) {
            this._awaitingHiddenStart = false;
          }
          return;
        }
      }



      // Check for QR Echo suppression
      // 1. Check for Metadata (Robust, works for history)
      // Only suppress if we have a relatedTid AND it's an outgoing message (User Response)
      // This prevents hiding incoming QR menus that might technically have a parent (relatedTid)
      const relatedTid = msg.relatedTid || (msg.extras && msg.extras.relatedTid);

      if (relatedTid) {
        console.log('[Debug] Message has relatedTid:', relatedTid, 'isOutgoing:', isOutgoing);

        if (isOutgoing) {
          const interactiveData = msg.interactiveData || (msg.extras && msg.extras.interactiveData);
          const data = interactiveData || { title: text };

          console.log('Suppressing QR echo based on relatedTid:', relatedTid);
          this.ui.markAsAnswered(relatedTid, data);
          return;
        }
      }

      // 2. Check for tracked clicks (Live fallback)
      // Normalize text for comparison
      const normalizedText = (text || '').trim().toLowerCase();

      if (!isHistory) {
        console.log('[Debug] Checking suppression for:', normalizedText);
        console.log('[Debug] Recent QRs:', Array.from(this.recentQRs));
      }

      if (!isHistory && this.recentQRs.has(normalizedText)) {
        console.log('Suppressing echoed QR message:', text);
        return;
      }

      // 3. De-duplication check for Optimistic UI
      const clientMessageId = msg.clientMessageId || (msg.extras && msg.extras.clientMessageId) || (msg.event && msg.event.extras && msg.event.extras.clientMessageId);
      if (!isHistory && clientMessageId) {
        // Check if UI already has this message (by temporary ID)
        if (this.ui.hasMessage(clientMessageId)) {
          console.log('[Debug] Duplicate message suppressed via clientMessageId:', clientMessageId);
          // Optional: Update the status of the existing message to 'sent' or 'delivered'
          return;
        }
      }

      // Update thread state
      const targetThreadId = (msg.thread && msg.thread.id) || this.activeThreadId;
      if (targetThreadId) {
        const thread = this.threads.find(t => t.id === targetThreadId);
        if (thread) {
          if (!thread.messages) thread.messages = [];
          thread.messages.push(msg);
        }
      }

      // RENDER BUBBLE via UI
      this.ui.addMessage(msg, isOutgoing, isHistory);
    }
  }

  async createNewChat() {
    this.view = 'chat';
    this.threadId = null; // New chat, no ID yet
    this.currentThreadId = null;
    this.activeThreadId = null;

    // Create thread immediately? Or wait for first message?
    // Current UX: clicking "Start New Chat" creates thread.
    try {
      const newThread = await WebexClient.createThread();
      if (newThread && newThread.id) {
        this.threads.unshift(newThread);
        this.openChat(newThread.id);
      }
    } catch (e) {
      console.error('Failed to create chat', e);
    }
  }

  async openChat(threadId) {
    this.view = 'chat';
    this.threadId = threadId; // Legacy support?
    this.activeThreadId = threadId;

    // Find thread and clear messages to prevent duplicates during history load
    const thread = this.threads.find(t => t.id === threadId);
    if (thread) {
      thread.messages = [];
    }

    this.isLoading = true;
    this.render();

    // Load History
    const list = this.shadowRoot.querySelector('.message-list');
    if (list) list.innerHTML = '';

    try {
      const history = await WebexClient.fetchHistory(threadId);

      // Pre-process history to link answers to forms
      const answersMap = new Map();
      if (history && history.length > 0) {
        history.forEach(msg => {
          // Check for relatedTid (Message extras or event extras)
          const relatedTid = msg.relatedTid || (msg.extras && msg.extras.relatedTid) || (msg.event && msg.event.extras && msg.event.extras.relatedTid);

          if (relatedTid) {
            answersMap.set(relatedTid, msg);
          }
        });

        // Mark answered forms
        history.forEach(msg => {
          const tid = msg.tid || (msg.event && msg.event.tid);
          if (tid && answersMap.has(tid)) {
            msg._isAnswered = true;
            const answerMsg = answersMap.get(tid);

            // Extract submitted values from answer payload
            // Answer payload should be: media[0].payload.fields[...].value
            const answerMedia = answerMsg.media || (answerMsg.event && answerMsg.event.media);
            if (answerMedia && answerMedia.length > 0) {
              const formPayload = answerMedia[0].payload;
              if (formPayload && formPayload.fields) {
                msg._submittedValues = {};
                formPayload.fields.forEach(f => {
                  msg._submittedValues[f.name] = f.value;
                });
              }
            }
          }
        });
      }


      this.isLoading = false;
      this.render();

      // Reverse to show oldest at top?
      // Depends on API. Assuming we need to reverse.
      if (history && history.length > 0) {
        history.reverse().forEach(msg => {
          this.handleMessage(msg, true);
        });
      }
    } catch (e) {
      console.error('History load error', e);
    }

    // Update input visibility logic handled in addMessage, calling updateInputVisibility()
    // But since handleMessage calls addMessage, it updates 50 times.
    // Performance improvement: batch updates?
    // For now, it's fine. calls are cheap DOM checks.

    this.ui.updateInputVisibility();

    // Ensure input is focused
    setTimeout(() => {
      if (this.ui) this.ui.focusInput();
    }, 100);
  }

  showList() {
    this.view = 'list';
    this.threadId = null;
    this.render();
    this.fetchThreadPreviews();
  }

  async sendMessage(textInput = null, media = null, extras = {}, skipUI = false) {
    const input = this.shadowRoot.querySelector('#chatInput');
    const text = textInput !== null ? textInput : (input ? input.value : '');

    if (!text && (!media || media.length === 0)) return;

    // Optimistic UI Update (if not skipUI)
    const clientMessageId = crypto.randomUUID();

    // Add clientMessageId to extras for de-duplication on echo
    if (!extras) extras = {};
    extras.clientMessageId = clientMessageId;

    if (!skipUI) {
      const tempMsg = {
        id: clientMessageId, // Use client ID temporarily
        message: text,
        media: media,
        outgoing: true,
        created: Date.now(),
        payload_type: 'sentByUser', // Ensure visibility logic sees it as user sent
        clientMessageId: clientMessageId // Pass strictly to UI
      };

      this.ui.addMessage(tempMsg, true, false); // Not history, so check for dups
    }

    if (input) input.value = '';

    // Extract interactiveData and relatedTid from extras to pass as root options
    // This fixes the malformed QR postback issue
    const options = { extras };
    if (extras.interactiveData) {
      options.interactiveData = extras.interactiveData;
      delete extras.interactiveData; // Logic choice: Remove from extras? 
      // Better to keep it in extras too if some legacy logic needs it, 
      // but Webex Connect expects it at root for flow processing.
    }
    if (extras.relatedTid) {
      options.relatedTid = extras.relatedTid;
      delete extras.relatedTid;
    }

    try {
      await WebexClient.sendMessage(this.activeThreadId, text, media, options);
    } catch (e) {
      console.error('Failed to send message', e);
      // Show error in UI?
    }
  }

  async handleFileUpload(file) {
    if (!file) return;

    this.ui.updateUploadProgress(0, true);

    console.log('Starting upload for:', file.name);

    try {
      const response = await WebexClient.uploadFile(file, (percent) => {
        this.ui.updateUploadProgress(percent, true);
      });
      console.log('Upload response received in handleFileUpload:', response);

      // Delay hiding progress bar to ensure user sees completion
      this.ui.updateUploadProgress(100, true);
      setTimeout(() => {
        this.ui.updateUploadProgress(0, false);
      }, 500);

      if (response && response.message) {
        const typeKey = response.description || 'file';

        const media = [{
          contentType: typeKey,
          [typeKey]: response.message
        }];

        // Send message with skipUI=true to prevent duplicate bubble (optimistic + real event)
        await this.sendMessage(null, media, {}, true);
      }
    } catch (e) {
      console.error('File upload failed', e);
      alert(this.i18n.t('upload_failed') || 'Upload failed');
      // Delay hiding on error to see if it appeared at all
      setTimeout(() => {
        this.ui.updateUploadProgress(0, false);
      }, 1000);
    }
  }

  handleSystemEvent(msg) {
    // 1. Agent Assigned
    if (msg.message === '$$$$$AGENTASSIGNED$$$$$') {
      const agentName = (msg.extras && msg.extras.customtags && msg.extras.customtags.agent) || 'Agent';
      this.ui.addSystemMessage(`${agentName} assigned`);
      return true;
    }

    // 2. Typing Events
    if (msg.message === '$$$$$TYPING$$$$$' || msg.payload_type === 'typingStart') {
      const typingStatus = msg.extras && msg.extras.customtags && msg.extras.customtags.typing;

      if (typingStatus === 'typing_on') {
        this.ui.showTyping();
      } else if (typingStatus === 'typing_off') {
        this.ui.hideTyping();
      }
      return true;
    }

    // 3. Legacy / Fallback
    const eventType = msg.type || (msg.event && msg.event.type);
    if (eventType === 'participant_joined') {
      const p = msg.participant || (msg.event && msg.event.participant) || {};
      const name = p.name || 'Agent';
      this.ui.addSystemMessage(`${name} assigned`);
      return true;
    }

    return false;
  }

  endConversation() {
    this.ui.addSystemMessage('Conversation ended.');
    const input = this.shadowRoot.querySelector('#chatInput');
    if (input) {
      input.disabled = true;
      input.placeholder = "Conversation ended";
    }
    const sendBtn = this.shadowRoot.querySelector('.send-btn');
    if (sendBtn) {
      sendBtn.disabled = true;
    }
  }

  // Proxies for CallManager to interact with UI
  updateCallStatus(status) {
    this.ui.updateCallStatus(status);
  }

  setCallControlsState(state) {
    this.ui.setCallControlsState(state);
  }

  startCallTimer() {
    this.ui.startCallTimer();
  }

  stopCallTimer() {
    this.ui.stopCallTimer();
  }

  renderCallControls() {
    this.ui.renderCallControls(this.currentCallStatus);
  }

  // Delegated methods from CallManager
  async startWebexCall(payload) {
    if (this.callManager) {
      this.currentCallStatus = null; // Reset status on new call attempt
      this._isConnected = false; // Ensure UI connected state is reset
      await this.callManager.startWebexCall(payload);
    }
  }

  async endWebexCall() {
    if (this.callManager) {
      await this.callManager.endWebexCall();
    }
  }

  _handleCallConnected() {
    if (this._isConnected) return; // Debounce
    this._isConnected = true;
    console.log('[Debug] Handling Call Connected State');
    this.ui.updateCallStatus(this.i18n.t('calling_status_connected', 'Connected'));
    this.ui.setCallControlsState('connected');
    this.ui.startCallTimer();
    this.currentCallStatus = 'connected';
  }
}

customElements.define('chat-widget', ChatWidget);

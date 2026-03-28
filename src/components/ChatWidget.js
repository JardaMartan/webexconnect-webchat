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
    this.threads = [];
    this.activeThreadId = null;
    this.currentUserId = null;
    this._conversationEnded = false;
    this._pendingReadReceipts = []; // Batch of TIDs to mark as read
    this.processedTids = new Set(); // Track message TIDs to prevent duplicates
    this.isOpen = false; // Default to closed (launcher view)
    this.isDark = false;
    this.audioSettingsPanel = new AudioSettingsPanel(this);
    this.callManager = new CallManager(this);
    this.ui = new ChatUI(this, this.shadowRoot);
    this.isLoading = false;
    this.recentQRs = new Set();
    this._openTime = 0;
    this._initialized = false; // Prevent duplicate init on remount

    this._handleThemeChange = this._handleThemeChange.bind(this);
    this._handleClickOutside = this._handleClickOutside.bind(this);
  }

  async connectedCallback() {
    // Guard against duplicate initialization (e.g. element disconnected+reconnected,
    // iframe reload, or DOM re-parenting). Without this, connectedCallback fires again
    // and init() → startSilentChat() creates a second chat thread.
    if (this._initialized) {
      console.log('[ChatWidget] connectedCallback skipped — already initialized');
      return;
    }
    this._initialized = true;

    // Configuration from attributes
    const startMsg = this.getAttribute('start-message') || null;
    const appId = this.getAttribute('app-id') || '';
    const clientKey = this.getAttribute('client-key') || '';
    const accessToken = this.getAttribute('access-token') || this.getAttribute('data-access-token') || '';
    const widgetId = this.getAttribute('widget-id') || this.getAttribute('data-bind') || '';
    const websiteId = this.getAttribute('website-id') || '0'; // Default to 0 if unknown
    const customProfileParams = this.getAttribute('custom-profile-params') || '';
    const websiteDomain = this.getAttribute('website-domain') || '';

    // Read optional context-params attribute (JSON string: '{"campaignToken":"...","customerToken":"..."}')
    const contextParamsAttr = this.getAttribute('context-params');
    if (contextParamsAttr) {
      try {
        this._contextParams = JSON.parse(contextParamsAttr);
      } catch (e) {
        console.warn('[ChatWidget] Invalid context-params attribute (must be JSON):', contextParamsAttr);
      }
    }

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

        // Unified derivation for any region: tenant-{region}or.{region}.webexconnect.io
        // e.g. us  -> tenant-usor.us.webexconnect.io
        //      uk  -> tenant-ukor.uk.webexconnect.io
        //      eu  -> tenant-euor.eu.webexconnect.io
        const suffix = `${region}or`;
        const apiTenant = tenant.endsWith(`-${suffix}`) ? tenant : `${tenant}-${suffix}`;
        const apiHost = [apiTenant, ...parts.slice(1)].join('.');

        if (!baseUrl) {
          baseUrl = `https://${apiHost}/rtmsAPI/api/v3`;
        }

        if (!mqttHost) {
          mqttHost = `${tenant}.msg-${suffix}.${region}.webexconnect.io`;
        }

        console.log(`[ChatWidget] Derived baseUrl: ${baseUrl}, mqttHost: ${mqttHost}`);
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

    // Propagate context params that were read from the HTML attribute (if any).
    // This must happen after initialize() so CONFIG is ready.
    if (this._contextParams && Object.keys(this._contextParams).length > 0) {
      WebexClient.setContextParams(this._contextParams);
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

        // Notify server on MQTT disconnect (connection lost)
        this.mqtt.onDisconnect(() => {
          console.log('[ChatWidget] MQTT disconnected — notifying server');
          WebexClient.notifyConnectionLost(0);
        });
      } catch (mqttErr) {
        console.error('Failed to connect to MQTT:', mqttErr);
      }

      // ── Browser lifecycle: beforeunload / visibilitychange ──────────
      this._beforeUnloadHandler = () => {
        WebexClient.notifyBrowserClosed(false);
        // If there's an active conversation that hasn't been ended, notify abandoned
        if (this.activeThreadId && !this._conversationEnded) {
          WebexClient.notifyAbandoned(false, false);
        }
      };
      window.addEventListener('beforeunload', this._beforeUnloadHandler);

      // Flush pending read receipts when the page becomes hidden or user switches tabs
      this._visibilityHandler = () => {
        if (document.visibilityState === 'hidden') {
          this._flushReadReceipts();
        }
      };
      document.addEventListener('visibilitychange', this._visibilityHandler);

      // 2. Auto-start only if there are no existing threads.
      const startMsg = this.getAttribute('start-message');
      const shouldAutoStart = startMsg && startMsg.trim().length > 0 && this.threads.length === 0;

      if (shouldAutoStart) {
        console.log('Auto-start detected. Starting immediately...');
        await this.startSilentChat(startMsg);
      } else {
        this.render();
      }
    } catch (e) {
      console.error('Init error', e);
    }
  }

  /** Flush any pending read receipts to the server. */
  _flushReadReceipts() {
    if (this._pendingReadReceipts.length > 0) {
      const tids = [...this._pendingReadReceipts];
      this._pendingReadReceipts = [];
      WebexClient.sendReadReceipts(tids).catch(() => {});
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
    // Clean up lifecycle listeners
    if (this._beforeUnloadHandler) {
      window.removeEventListener('beforeunload', this._beforeUnloadHandler);
    }
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
    }
    this._flushReadReceipts();
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
              // Find the last message that is a real user/agent message, skipping
              // internal service messages ($$$$$ flags, closeThread events, etc.)
              const isServiceMsg = (m) => {
                const txt = m.message || (m.event && m.event.message && m.event.message.text) || '';
                if (txt.startsWith('$$$$$')) return true;
                if (m.payload_type === 'closeThread') return true;
                return false;
              };
              const last = msgs.find(m => !isServiceMsg(m));
              if (last) {
                const txt = last.message || (last.event && last.event.message && last.event.message.text) || (last.media ? this.i18n.t('attachment_label', 'Attachment') : this.i18n.t('no_preview', 'No preview'));
                t.last_message = txt;
                // Re-render to show preview
                this.render();
              }
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

    // Check for Conversation End — only for live messages, not history replay.
    // Historical messages may have thread.status === 'Closed' for past-closed threads
    // that have since been reopened; applying endConversation() on them would
    // wrongly disable the input and show "Conversation ended" on an active chat.
    if (!isHistory && (msg.payload_type === 'closeThread' || (msg.thread && msg.thread.status === 'Closed'))) {
      this.endConversation();
      // endConversation() already adds the "Conversation ended" system message locally,
      // so we return here to prevent the server's close-event text from being rendered
      // as a second duplicate bubble.
      return;
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

      // Send delivery receipt + queue read receipt for incoming (non-outgoing) messages
      if (!isOutgoing && !isHistory && msg.tid) {
        WebexClient.sendDeliveryReceipt(msg.tid).catch(() => {});
        this._pendingReadReceipts.push(msg.tid);
        // Auto-flush read receipts every 5 messages or after a short delay
        if (this._pendingReadReceipts.length >= 5) {
          this._flushReadReceipts();
        } else {
          clearTimeout(this._readReceiptTimer);
          this._readReceiptTimer = setTimeout(() => this._flushReadReceipts(), 2000);
        }
      }
    }
  }

  async createNewChat() {
    // If a start-message is configured, use startSilentChat() which creates the thread
    // AND sends the (possibly hidden) initial message — same path as the auto-start on
    // first load. This handles the case where the user has existing threads and manually
    // clicks "Start New Chat".
    if (this._startMessage && this._startMessage.trim().length > 0) {
      await this.startSilentChat(this._startMessage);
      return;
    }

    // No start-message: create a plain blank thread.
    this.view = 'chat';
    this.threadId = null;
    this.currentThreadId = null;
    this.activeThreadId = null;

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
    this._conversationEnded = false; // Reset per-thread ended flag

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

    // Update input visibility
    this.ui.updateInputVisibility();

    // For closed threads viewed in history, show the "Conversation ended" banner.
    // this.threads is populated by fetchThreads() which returns status from the API,
    // and endConversation() stamps status='Closed' when a live close event fires.
    const closedThread = this.threads.find(t => t.id === threadId);
    if (closedThread && closedThread.status === 'Closed') {
      this.endConversation();
    }

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

      if (response && response.mediaId) {
        // The SDK upload returns:
        //   { mediaId: "4435692935633384", file: "https://london-rtmedia.s3.amazonaws.com/...", contentType: "image/png" }
        // The Webex Connect platform expects the URL key to match the contentType value:
        //   contentType "image" → key "image", contentType "video" → key "video", etc.
        const simpleType = (response.contentType || 'file').split('/')[0];
        console.log('[ChatWidget] Upload mediaId:', response.mediaId, 'file:', response.file, 'contentType:', simpleType);

        const mediaObj = {
          contentType: simpleType,
          id: response.mediaId
        };
        // Use the contentType as the key for the URL (e.g. "image": "https://...")
        mediaObj[simpleType] = response.file;

        const media = [mediaObj];

        // Send message with skipUI=true to prevent duplicate bubble (optimistic + real event)
        // Pass empty string (not null) to avoid sendMessage reading input.value
        await this.sendMessage('', media, {}, true);
      } else {
        console.warn('[ChatWidget] Upload response missing mediaId:', JSON.stringify(response));
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
      const agentName = (msg.extras && msg.extras.customtags && msg.extras.customtags.agent) || this.i18n.t('agent_label', 'Agent');
      this.ui.addSystemMessage(`${agentName} ${this.i18n.t('agent_assigned', 'assigned')}`);
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
      const name = p.name || this.i18n.t('agent_label', 'Agent');
      this.ui.addSystemMessage(`${name} ${this.i18n.t('agent_assigned', 'assigned')}`);
      return true;
    }

    return false;
  }

  endConversation() {
    // Guard against being called twice for the same thread (e.g. two close-event
    // MQTT messages arriving: one payload_type=closeThread and one thread.status=Closed).
    if (this._conversationEnded) return;
    this._conversationEnded = true;

    // Stamp the active thread as Closed in our local store so that when the user
    // navigates back to the list and reopens this thread, openChat() can detect
    // it is closed without needing an extra API call.
    if (this.activeThreadId && this.threads) {
      const t = this.threads.find(th => th.id === this.activeThreadId);
      if (t) t.status = 'Closed';
    }

    this.ui.addSystemMessage(this.i18n.t('conversation_ended', 'Conversation ended.'));
    const input = this.shadowRoot.querySelector('#chatInput');
    if (input) {
      input.disabled = true;
      input.placeholder = this.i18n.t('conversation_ended_placeholder', 'Conversation ended');
    }
    const sendBtn = this.shadowRoot.querySelector('.send-btn');
    if (sendBtn) {
      sendBtn.disabled = true;
    }
    // Disable all call buttons (QR call options + webex call cards)
    this.shadowRoot.querySelectorAll('.qr-button-call, .webex-call-card md-button').forEach(btn => {
      btn.disabled = true;
      btn.setAttribute('disabled', '');
    });

    // Notify server the chat ended (widget-layer protocol)
    if (this.activeThreadId) {
      WebexClient.endChat(this.activeThreadId).catch(() => {});
    }

    // Flush any remaining read receipts
    this._flushReadReceipts();
  }

  /**
   * Set opaque context tokens that will be carried in extras on every message
   * for this session. Call this from the host page before or after the widget
   * is opened. Tokens are forwarded to the Webex Connect flow where they can
   * be used to look up customer records without exposing PII in the browser.
   *
   * @param {Object} params  Plain object, e.g. { campaignToken: 'CAMP-2024-Q1', customerToken: 'abc123' }
   */
  setContext(params) {
    this._contextParams = params && typeof params === 'object' ? { ...params } : {};
    WebexClient.setContextParams(this._contextParams);
    console.log('[ChatWidget] setContext() called with:', this._contextParams);
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
  async startWebexCall(payload, postbackFn = null) {
    if (this.callManager) {
      this.currentCallStatus = null; // Reset status on new call attempt
      this._isConnected = false; // Ensure UI connected state is reset
      await this.callManager.startWebexCall(payload, postbackFn);
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

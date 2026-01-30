import { WebexClient } from '../api/WebexClient';
import { RealtimeClient } from '../api/RealtimeClient';
import { Localization } from '../i18n';
import styles from './chat-widget.css?inline';

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
    this._handleThemeChange = this._handleThemeChange.bind(this);
  }

  async connectedCallback() {
    // Configuration from attributes
    const startMessage = this.getAttribute('start-message') || null;
    const appId = this.getAttribute('app-id') || '';
    const clientKey = this.getAttribute('client-key') || '';
    const baseUrl = this.getAttribute('base-url') || '';
    const accessToken = this.getAttribute('access-token') || this.getAttribute('data-access-token') || '';

    // Localization
    const langAttr = this.getAttribute('lang') || navigator.language || 'en';
    const lang = langAttr.split('-')[0]; // simple 'en', 'es' support
    this.i18n = new Localization(lang);

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
        accessToken
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
  }

  async init() {
    try {
      this.currentUserId = WebexClient.getUserId();
      this.threads = await WebexClient.getThreads();
      console.log('Fetched Threads:', this.threads);

      // Auto-Start Check
      const startMsg = this.getAttribute('start-message');
      let autoStarted = false;
      if (this.threads.length === 0 && startMsg) {
        console.log('No existing threads and start-message found. Auto-starting...');
        await this.startSilentChat(startMsg);
        autoStarted = true;
      }

      if (!autoStarted) {
        if (this.threads.length > 0) {
          this.showList();
        } else {
          // Show empty state or launcher
          this.render();
        }
      }

      const mqttCreds = await WebexClient.getMqttCredentials();
      this.mqtt.connect(mqttCreds);

      // Subscribe with correct topic
      const appId = this.getAttribute('app-id');
      this.mqtt.subscribeToUserTopic(appId, this.currentUserId);

      this.mqtt.onMessage(this.handleMessage.bind(this));
    } catch (e) {
      console.error('Init error', e);
    }
  }

  // ... (disconnectedCallback, handleMessage remain same)

  disconnectedCallback() {
    const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    darkModeQuery.removeEventListener('change', this._handleThemeChange);
  }

  _handleThemeChange(e) {
    this.isDark = e.matches;
    this.render();
  }

  // ... (disconnectedCallback, handleMessage remain same)

  toggle() {
    this.isOpen = !this.isOpen;
    this.render();
  }

  async startSilentChat(message) {
    if (!this.isOpen) {
      this.toggle(); // Open widget
    }

    try {
      // 1. Create New Thread
      const newThread = await WebexClient.createThread();
      this.threads.unshift(newThread);

      // Use standard openChat to ensure event listeners and focus work
      await this.openChat(newThread.id);

      // 2. Send Message (Visible or Hidden based on config)
      const hidden = this.hasAttribute('start-message-hidden') && this.getAttribute('start-message-hidden') !== 'false';
      console.log('Auto-starting chat. Message:', message, 'Hidden:', hidden);

      if (hidden) {
        this._awaitingHiddenStart = true;
      }

      // Pass 'hidden' as skipUI param (4th arg)
      await this.sendMessage(message, null, {}, hidden);
      // No TID capture needed


    } catch (e) {
      console.error('Auto-start failed', e);
    }
  }

  // ... (createNewChat, openChat, showList, sendMessage, addMessageToUI, handleMessage etc. - we need to preserve them. 
  // Since I am replacing the whole class structure in the prompt instruction context, I need to be careful.
  // Actually, I'll direct the tool to just replace specific methods or blocks if possible, but the render change is large.)

  // Let's replace render() completely to handle the FAB view.

  render() {
    if (!this.isOpen) {
      // Render Launcher
      this.shadowRoot.innerHTML = `
            <style>${styles}</style>
            <md-theme lumos ${this.isDark ? 'darkTheme' : ''}>
            <div class="launcher-container">
              <md-button variant="primary" size="52" circle id="launcherBtn" class="launcher">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                  <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
                </svg>
              </md-button>
            </div>
          </md-theme>
      `;
      this.shadowRoot.querySelector('#launcherBtn').addEventListener('click', () => this.toggle());
      return;
    }

    // Render Full Window
    let contentHtml = '';
    let headerHtml = '';
    let footerHtml = '';

    if (this.view === 'list') {
      headerHtml = `
          <span>${this.i18n.t('my_chats')}</span>
          <div class="close-btn" id="closeBtn">✕</div>
      `;
      const threadsHtml = this.threads.map(t => `
        <md-list-item slot="list-item" class="thread-item" data-id="${t.id}">
          <div slot="start" class="thread-avatar">
            ${(t.title || 'C').charAt(0)}
          </div>
          <div class="thread-title">${t.title || this.i18n.t('default_title')}</div>
          <div class="thread-id">ID: ${t.id.slice(0, 8)}...</div>
        </md-list-item>
      `).join('');

      contentHtml = `
        <div class="view-container" style="position:relative">
          <div class="content-padded">
             <md-button id="newChatBtn" variant="primary" class="new-chat-btn">${this.i18n.t('start_new_chat')}</md-button>
          </div>
          <md-list>
            ${threadsHtml}
          </md-list>
        </div>
      `;
    } else {
      headerHtml = `
        <div class="header-left">
          <md-button variant="ghost" size="28" circle class="back-btn">
             <svg xmlns="http://www.w3.org/2000/svg" style="width:20px;height:20px;fill:currentColor;" viewBox="0 0 24 24">
               <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
             </svg>
          </md-button>
          <span>${this.i18n.t('chat_header')}</span>
        </div>
        <div class="close-btn" id="closeBtn">✕</div>
      `;
      contentHtml = `
        <div class="message-list">
          <div class="start-label">${this.i18n.t('start_conversation')}</div>
        </div>
      `;
      footerHtml = `
        <footer>
          <md-input id="chatInput" placeholder="${this.i18n.t('input_placeholder')}" clear shape="pill"></md-input>
          <md-button class="send-btn" variant="primary" size="32" circle>
            <svg xmlns="http://www.w3.org/2000/svg" style="width:16px;height:16px;fill:currentColor;" viewBox="0 0 24 24">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
            </svg>
          </md-button>
        </footer>
      `;
    }

    this.shadowRoot.innerHTML = `
        <style>${styles}</style>
          <div class="window">
            <md-theme lumos ${this.isDark ? 'darkTheme' : ''}>
              <div class="view-container">
                <header>${headerHtml}</header>
                <div class="content">${contentHtml}</div>
                ${footerHtml}
              </div>
            </md-theme>
          </div>
      `;

    // Event Listeners for Window Mode
    const closeBtn = this.shadowRoot.querySelector('#closeBtn');
    if (closeBtn) closeBtn.addEventListener('click', () => this.toggle());

    if (this.view === 'list') {
      this.shadowRoot.querySelector('#newChatBtn').addEventListener('click', () => this.createNewChat());
      this.shadowRoot.querySelectorAll('.thread-item').forEach(item => {
        item.addEventListener('click', () => this.openChat(item.dataset.id));
      });
    } else {
      this.shadowRoot.querySelector('.back-btn').addEventListener('click', () => this.showList());
      this.shadowRoot.querySelector('.send-btn').addEventListener('click', () => this.sendMessage());

      const input = this.shadowRoot.querySelector('#chatInput');
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.sendMessage();
      });
      input.addEventListener('input-keydown', (e) => {
        if (e.detail.key === 'Enter') this.sendMessage();
      });
    }
  }
  handleMessage(msg, isHistory = false) {
    console.log('Handling message', msg, isHistory ? '(History)' : '');

    // 0. System Events (Typing, Assigned)
    if (this.handleSystemEvent(msg)) return;

    // Clear typing if a real message arrives
    if ((msg.message || msg.media) && !msg.outgoing) {
      this.hideTyping();
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
      // ... existing logic ...
      // Reverted strict userId check because incoming bot messages also have user's ID.
      // Rely on msg.outgoing or specific payload flags if available.
      let isOutgoing = msg.outgoing === true;

      // Secondary check: if payload_type is explicitly sentByUser
      if (!isOutgoing && msg.payload_type === 'sentByUser') {
        isOutgoing = true;
      }

      // Logic to suppress Hidden Start Message (Live)
      const startMsg = this.getAttribute('start-message');
      const startHidden = this.hasAttribute('start-message-hidden') && this.getAttribute('start-message-hidden') !== 'false';

      if (startHidden) {
        // SIMPLE LOGIC: If we are awaiting the hidden start message echo,
        // and this message looks like it (content match), suppress it.
        // This handles both "Pre-Send" race conditions and normal flows.
        if (this._awaitingHiddenStart && text && !isHistory) {
          const normalized = text.trim().toLowerCase();
          const expected = (startMsg || '').trim().toLowerCase();

          if (normalized === expected) {
            console.log('Hiding hidden start message match:', text);
            this._awaitingHiddenStart = false; // Clear flag
            if (tid) this.processedTids.add(tid);
            return;
          }
        }
      }

      // If it's outgoing and NOT history, skip it (echo prevention)
      if (isOutgoing && !isHistory) {
        // If we skipped UI logic in sendMessage, we shouldn't skip here?
        // Actually, existing logic says "Skip ALL outgoing echoes".
        // This implies optimistic UI is ALWAYS used or we don't care about confirmation.
        // BUT for auto-start, we might NOT have optimistic UI if we used skipUI param.
        // Checking existing sendMessage... 
        // "if (text && !media && !skipUI) { addMessageToUI... }"
        // So if skipUI is true, we DO NOT have it on UI. 
        // So we MUST allow it to pass here?
        // The previous logic was: if (hidden) _suppressNextOutgoing = true;

        // Fix: If it's outgoing, we generally skip echo. 
        // UNLESS it's the start message that we WANTED to show (start-message-hidden=false) but skipped generic UI?
        // No, if start-message-hidden=false, then hidden=false, so skipUI=false. So optimistic UI IS added.
        // So we can safely skip echo.

        console.log('Skipping outgoing message echo:', text || 'media');
        return;
      }

      // Deduplication check
      // const tid = msg.tid || (msg.event && msg.event.tid);

      // Removed "hiddenTids" check as we use content matching now.

      if (tid) {
        if (this.processedTids.has(tid)) {
          console.log('Skipping duplicate message:', tid);
          return;
        }
        this.processedTids.add(tid);
      }

      if (this.view === 'chat' && this.threadId) {
        this.addMessageToUI({
          ...msg, // Pass all props (crucial for _isAnswered, _selectedIdentifier from Merge)
          message: text,
          media: media,
          outgoing: isOutgoing,
          isHistory: isHistory,
          created: msg.created_on || msg.created || msg.ts, // Pass timestamp
          tid: tid
        });
      }
    }
  }

  async createNewChat() {
    try {
      const newThread = await WebexClient.createThread();
      this.threads.unshift(newThread);

      // Await openChat to ensure history is loaded/cleared before we send new message
      await this.openChat(newThread.id);

      // Check for automated start message
      const startMsg = this.getAttribute('start-message');
      const hidden = this.hasAttribute('start-message-hidden') && this.getAttribute('start-message-hidden') !== 'false';

      if (startMsg) {
        console.log('Auto-sending start message (New Chat). Hidden:', hidden);

        if (hidden) {
          this._awaitingHiddenStart = true;
        }

        // Send immediately
        await this.sendMessage(startMsg, null, {}, hidden);
      }
    } catch (e) {
      console.error('Failed to create thread', e);
    }
  }

  async openChat(threadId) {
    this.threadId = threadId;
    this.view = 'chat';
    this.render();

    // Auto-focus immediately
    setTimeout(() => {
      const input = this.shadowRoot.querySelector('#chatInput');
      if (input) input.focus();
    }, 100);

    // Fetch History
    try {
      const messages = await WebexClient.fetchHistory(threadId);
      // We need to render them old -> new. API usually returns new -> old or old -> new?
      // Let's assume date sorting is needed or check HAR. 
      // Sort old -> new
      messages.sort((a, b) => new Date(a.created_on || 0) - new Date(b.created_on || 0));

      // Filter Hidden Start Message in History via Content/Positional
      const startHidden = this.hasAttribute('start-message-hidden') && this.getAttribute('start-message-hidden') !== 'false';
      const startMsg = this.getAttribute('start-message');

      if (startHidden && startMsg && messages.length > 0) {
        // Find the FIRST message that matches text (ignoring direction for robustness)
        for (const m of messages) {
          const text = m.message || '';
          const textMatch = text.trim().toLowerCase() === startMsg.trim().toLowerCase();

          if (textMatch) {
            console.log('Hiding start message in history (Content Match):', text);
            m._skipRendering = true;
            break; // STOP after hiding the first one
          }
        }
      }

      // Merge Logic: Pair "sentToUser" forms/QRs with "sentByUser" responses
      // Iterate to find Answers, then look back for Questions
      messages.forEach((msg, index) => {
        // 1. Check if this is a FORM ANSWER (User sent, has Form payload)
        const isFormAnswer = (msg.payload_type === 'sentByUser' || msg.outgoing) &&
          msg.media &&
          msg.media.some(m => m.templateType === 'form');

        // 2. Check if this is a QR ANSWER (User sent, has interactiveData + relatedTid)
        const isQrAnswer = (msg.payload_type === 'sentByUser' || msg.outgoing) &&
          msg.interactiveData &&
          msg.relatedTid;

        if (isFormAnswer) {
          msg.media.forEach(m => {
            if (m.templateType === 'form' && m.templateId) {
              // Look BACKWARDS for the nearest Question with this templateId
              for (let i = index - 1; i >= 0; i--) {
                const diffMsg = messages[i];
                // Must be sentToUser (Question) and have same templateId and NOT Answered yet
                const isQuestion = diffMsg.payload_type === 'sentToUser' &&
                  diffMsg.media &&
                  diffMsg.media.some(qm => qm.templateId === m.templateId) &&
                  !diffMsg._isAnswered;

                if (isQuestion) {
                  // Start Merge
                  const questionMedia = diffMsg.media.find(qm => qm.templateId === m.templateId);
                  const answerFields = (m.payload && m.payload.fields) || [];

                  if (questionMedia && questionMedia.payload && questionMedia.payload.fields) {
                    questionMedia.payload.fields.forEach(qField => {
                      const aField = answerFields.find(af => af.name === qField.name);
                      if (aField && aField.value) {
                        qField.value = aField.value;
                      }
                    });
                  }

                  diffMsg._isAnswered = true;
                  msg._skipRendering = true;
                  // Stop searching for this specific answer template (Match found)
                  break;
                }
              }
            }
          });
        } else if (isQrAnswer || (msg.relatedTid && !msg.interactiveData)) {
          // QR Merge (with fallback for missing interactiveData in History)
          const relatedTid = msg.relatedTid;
          let selectedIdentifier = msg.interactiveData ? msg.interactiveData.identifier : null;

          // Look BACKWARDS for the Question (msg with tid == relatedTid and has quickReplies)
          for (let i = index - 1; i >= 0; i--) {
            const diffMsg = messages[i];
            if (diffMsg.tid === relatedTid && diffMsg.quickReplies && !diffMsg._isAnswered) {

              // Fallback: If no identifier, match by Text (Message Title)
              if (!selectedIdentifier && msg.message && diffMsg.quickReplies.options) {
                const match = diffMsg.quickReplies.options.find(o =>
                  o.title && msg.message &&
                  o.title.trim().toLowerCase() === msg.message.trim().toLowerCase()
                );
                if (match) {
                  selectedIdentifier = match.identifier;
                }
              }

              if (selectedIdentifier) {
                diffMsg._isAnswered = true;
                diffMsg._selectedIdentifier = selectedIdentifier;

                // Hide the answer bubble (echo suppression)
                msg._skipRendering = true;
              }
              break;
            }
          }
        }
      });

      // Cleanup: Hide Abandoned Forms AND Quick Replies (Unanswered & not last)
      messages.forEach((msg, index) => {
        if (msg._skipRendering) return;

        const isForm = msg.payload_type === 'sentToUser' && msg.media && msg.media.some(m => m.templateType === 'form');
        const isQr = msg.payload_type === 'sentToUser' && msg.quickReplies;

        // If it's a Form/QR, and NOT answered, and NOT the last message... hide it!
        if ((isForm || isQr) && !msg._isAnswered && index < messages.length - 1) {
          console.log('Hiding abandoned interactive message:', msg.tid);
          msg._skipRendering = true;
        }
      });

      // Clear current list content (except the "Start of conversation" label?)
      const list = this.shadowRoot.querySelector('.message-list');
      if (list) {

        list.innerHTML = `<div style="text-align:center; color:#999; font-size:12px; margin-top:20px;">${this.i18n.t('start_conversation')}</div>`;

        // Fix: Clear processedTids because we just wiped the UI. 
        // Any previously rendered realtime msg is gone, so we must allow history to re-render it.
        this.processedTids.clear();

        messages.forEach(msg => {
          if (msg._skipRendering) return; // Skip merged messages

          // Reuse existing handler logic to render
          // But handleMessage logs & filters system events. 
          // We should refactor rendering or just direct call addMessageToUI/handleSystemEvent

          // If it's a system event, render it as system message
          if (msg.message === '$$$$$AGENTASSIGNED$$$$$' || msg.type === 'participant_joined') {
            this.handleSystemEvent(msg);
          } else if (!this.handleSystemEvent(msg)) { // If NOT a handled system event (like typing)
            // Filter out typing events from history if they persist
            if (msg.message !== '$$$$$TYPING$$$$$' && msg.payload_type !== 'typingStart') {
              this.handleMessage(msg, true); // Pass flag isHistory=true
            }
          }
        });
      }
    } catch (e) {
      console.error('History load error', e);
    }
  }

  showList() {
    this.view = 'list';
    this.threadId = null;
    this.render();
  }

  async sendMessage(overrideText = null, overrideMedia = null, options = {}, skipUI = false) {
    let text = overrideText;
    let media = overrideMedia;

    if (!text && !media) {
      const input = this.shadowRoot.querySelector('#chatInput');
      if (input) {
        text = input.value;
        input.value = '';
      }
    }

    if ((!text && !media) || !this.threadId) {
      return;
    }

    try {
      // Optimistically add ONLY if TEXT and NOT skipping UI.
      // If MEDIA (Form response), the form itself changes state (disabled), so no new bubble needed.
      if (text && !media && !skipUI) {
        this.addMessageToUI({
          message: text,
          media: null,
          outgoing: true,
          created: Date.now(), // Add timestamp for local display
          ...options // Pass options (relatedTid) to trigger echo suppression
        });
      }

      const response = await WebexClient.sendMessage(this.threadId, text, media, options);

      // If we skipped UI (hidden start message), we no longer track TID for blacklist
      // as we use content matching in handleMessage. 
      // if (skipUI && response) ...

    } catch (e) {
      console.error('Send failed', e);
    }
  }

  addMessageToUI(msg) {
    // Skip outgoing/incoming QR Answers (echo suppression)
    // If a message has relatedTid, it is a response to a previous message (QR Answer).
    // We hide it because the Selection Highlight on the original Question serves as the record.
    if (msg.relatedTid) {
      console.log('Skipping QR answer echo:', msg.message);
      return;
    }

    const list = this.shadowRoot.querySelector('.message-list');
    if (!list) return;

    const isOutgoing = msg.outgoing === true;

    const item = document.createElement('div');
    item.className = isOutgoing ? 'bubble outgoing' : 'bubble incoming';

    // Check if media contains a form (to suppress duplicate text echo)
    const hasForm = msg.media && msg.media.some(m => m.templateType === 'form');

    // 1. Text Content
    // Only render text if NO form, OR if it's not just an echo (hard to detect, so strictly prioritizing Form)
    if (msg.message && !hasForm) {
      const textDiv = document.createElement('div');
      textDiv.textContent = msg.message;
      item.appendChild(textDiv);
    }

    // 2. Rich Media (Forms)
    if (msg.media && Array.isArray(msg.media)) {
      // RENDER FORM (Both Incoming and Outgoing)
      // RENDER FORM (Both Incoming and Outgoing)
      msg.media.forEach(m => {
        if (m.templateType === 'form' && m.payload) {
          const formContainer = document.createElement('div');
          formContainer.className = 'form-container';

          if (m.payload.title) {
            const title = document.createElement('div');
            title.textContent = m.payload.title;
            title.className = 'form-title';
            formContainer.appendChild(title);
          }

          const inputs = [];
          // Disable if it's history (prevents re-submit) OR if it's an outgoing message (already submitted)
          // Also disable if marked as _isAnswered (merged history)
          const isDisabled = (msg.isHistory === true) || isOutgoing || msg._isAnswered;

          (m.payload.fields || []).forEach(field => {
            const inputWrapper = document.createElement('div');
            inputWrapper.style.marginBottom = '8px'; // Keep simple layout style or move to CSS class 'input-wrapper'

            if (field.label) {
              const label = document.createElement('label');
              label.textContent = field.label;
              label.style.display = 'block';
              label.style.marginBottom = '4px';
              label.style.fontSize = '12px';
              label.style.fontWeight = '500';
              inputWrapper.appendChild(label);
            }

            let input;
            if (field.type === 'textarea') {
              input = document.createElement('md-input'); // Use md-input for consitency if possible, or native textarea
              input.multiline = true;
            } else {
              input = document.createElement('md-input');
              input.type = field.type || 'text';
            }
            input.setAttribute('shape', 'pill'); // Apply pill style for all inputs

            input.name = field.name;
            input.value = field.value || '';
            input.placeholder = field.description || '';
            if (field.mandatory) input.required = true;
            if (isDisabled) input.disabled = true;

            inputs.push(input);
            inputWrapper.appendChild(input);
            formContainer.appendChild(inputWrapper);
          });

          // Submit Button (Only if NOT disabled)
          if (!isDisabled) {
            const submitBtn = document.createElement('md-button');
            submitBtn.variant = 'primary';
            submitBtn.size = '28';
            submitBtn.textContent = this.i18n.t('submit');
            submitBtn.style.marginTop = '8px';

            submitBtn.addEventListener('click', () => {
              // Collect Data
              const formData = inputs.map(input => ({
                name: input.name,
                value: input.value,
                label: input.previousElementSibling ? input.previousElementSibling.textContent : input.name
              }));

              // Validate Mandatory
              const missing = inputs.filter(i => i.required && !i.value);
              if (missing.length > 0) {
                alert('Please fill required fields');
                return;
              }

              // Send Response
              this.sendMessage(null, [{
                templateType: 'form',
                templateId: m.templateId,
                payload: { fields: formData }
              }]);

              // Disable Form locally
              inputs.forEach(i => i.disabled = true);
              submitBtn.remove();
              const sentLabel = document.createElement('div');
              sentLabel.textContent = this.i18n.t('submitted');
              sentLabel.style.color = '#0070d2';
              sentLabel.style.fontSize = '12px';
              sentLabel.style.marginTop = '8px';
              formContainer.appendChild(sentLabel);
            });
            formContainer.appendChild(submitBtn);
          } else {
            // If disabled (e.g. history), show "Submitted" status if it was an answer or history?
            // For now, just leave inputs disabled.
          }

          item.appendChild(formContainer);
        } else {
          // RENDER OTHER MEDIA (Image, Video, File)
          const type = m.contentType || m.mimeType || '';
          const url = m.url || m.contentUrl;

          if (type.includes('image')) {
            const img = document.createElement('img');
            img.src = url;
            img.className = 'chat-media-img';
            item.appendChild(img);

          } else if (type.includes('video')) {
            const video = document.createElement('video');
            video.src = url;
            video.controls = true;
            video.className = 'chat-media-video';
            item.appendChild(video);

          } else if (type.includes('audio')) {
            const audio = document.createElement('audio');
            audio.src = url;
            audio.controls = true;
            audio.className = 'chat-media-audio';
            item.appendChild(audio);

          } else if (type === 'location' || (m.latitude && m.longitude) || (m.payload && m.payload.latitude)) {
            // Location Map
            const lat = m.latitude || (m.payload && m.payload.latitude);
            const lon = m.longitude || (m.payload && m.payload.longitude);
            if (lat && lon) {
              const mapContainer = document.createElement('div');
              mapContainer.className = 'chat-media-map';

              const iframe = document.createElement('iframe');
              iframe.width = "250";
              iframe.height = "150";
              iframe.style.border = "0";
              iframe.loading = "lazy";
              iframe.allowFullscreen = true;
              // Using basic map embed format
              iframe.src = `https://maps.google.com/maps?q=${lat},${lon}&z=15&output=embed`;

              mapContainer.appendChild(iframe);
              item.appendChild(mapContainer);
            }

          } else if (type.includes('application') || type.includes('pdf') || type.includes('text/') || type === 'attachment' || type === 'file') {
            // Generic File Attachment
            const fileContainer = document.createElement('div');
            fileContainer.className = 'chat-media-file';

            const icon = document.createElement('span');
            icon.textContent = '📎'; // Simple icon

            const link = document.createElement('a');
            link.href = url;
            link.textContent = m.fileName || 'Download File';
            link.target = '_blank'; // Open in new tab
            link.className = 'file-link';
            // Forcing download might require proxy if header missing, but 'download' attr helps

            fileContainer.appendChild(icon);
            fileContainer.appendChild(link);
            item.appendChild(fileContainer);
          }
        }
      });
    }

    // 3. Quick Replies
    if (msg.quickReplies && msg.quickReplies.options && Array.isArray(msg.quickReplies.options)) {
      console.log('Rendering Quick Replies:', msg.quickReplies.options);
      const qrContainer = document.createElement('div');
      qrContainer.className = 'qr-container';

      msg.quickReplies.options.forEach(opt => {
        const btn = document.createElement('md-button');
        btn.variant = 'secondary';
        btn.size = '28';
        btn.textContent = opt.title;
        btn.className = 'qr-button';

        // Helper: Highlight selected by making it unclickable but NOT 'disabled' (to keep color)
        const highlightSelected = (button) => {
          button.setAttribute('variant', 'primary');
          button.removeAttribute('disabled'); // Ensure not disabled
          button.classList.add('qr-button-selected');
        };

        // Determine state based on history merge
        if (msg._isAnswered) {
          // Check match
          if (opt.identifier == msg._selectedIdentifier) {
            highlightSelected(btn);
          } else {
            btn.disabled = true; // Grey out others
          }
        } else if (msg.isHistory || isOutgoing) {
          // Fallback for unmerged history (abandoned or old)
          btn.disabled = true;
        } else {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();

            // Construct Interactive Data for exact HAR mimicry
            const interactiveData = {
              type: opt.type || "quickReplyPostback",
              identifier: opt.identifier,
              payload: opt.payload || {},
              title: opt.title,
              reference: msg.quickReplies.reference || "service", // Use parent reference or valid default
              url: opt.url || ""
            };

            // Send with relatedTid (the ID of the message asking the question)
            this.sendMessage(opt.title, null, {
              relatedTid: msg.tid,
              interactiveData: interactiveData
            });

            // Enhancement: Highlight the clicked button and disable all others
            msg._isAnswered = true;
            msg._selectedIdentifier = opt.identifier;

            Array.from(qrContainer.children).forEach(b => {
              if (b === btn) {
                highlightSelected(b);
              } else {
                b.disabled = true;
              }
            });
          });
        }
        qrContainer.appendChild(btn);
      });
      item.appendChild(qrContainer);
    }

    // Wrap structure: Container -> [Bubble, Timestamp]
    if (item.hasChildNodes()) {
      const container = document.createElement('div');
      container.className = isOutgoing ? 'msg-container outgoing' : 'msg-container incoming';

      container.appendChild(item);

      // Timestamp (Below Bubble)
      if (msg.created_on || msg.created) {
        const ts = msg.created_on || msg.created;
        const timeDiv = document.createElement('div');
        timeDiv.className = 'timestamp';
        timeDiv.textContent = this.formatTime(ts);
        container.appendChild(timeDiv);
      }

      list.appendChild(container);
      setTimeout(() => list.scrollTop = list.scrollHeight, 0);
    }
  }

  formatTime(timestamp) {
    if (!timestamp) return '';
    try {
      const date = new Date(timestamp);
      // Use browser's preferred language for formatting
      return new Intl.DateTimeFormat(navigator.language, {
        hour: '2-digit',
        minute: '2-digit'
      }).format(date);
    } catch (e) {
      return '';
    }
  }



  handleSystemEvent(msg) {
    // 1. Agent Assigned
    // Format: message: "$$$$$AGENTASSIGNED$$$$$", extras: { customtags: { agent: "Alice" } }
    if (msg.message === '$$$$$AGENTASSIGNED$$$$$') {
      const agentName = (msg.extras && msg.extras.customtags && msg.extras.customtags.agent) || 'Agent';
      this.addSystemMessage(`${agentName} assigned`);
      return true;
    }

    // 2. Typing Events
    // Format: message: "$$$$$TYPING$$$$$", extras: { customtags: { typing: "typing_on" | "typing_off" } }
    // Or payload_type: "typingStart"
    if (msg.message === '$$$$$TYPING$$$$$' || msg.payload_type === 'typingStart') {
      const typingStatus = msg.extras && msg.extras.customtags && msg.extras.customtags.typing;

      if (typingStatus === 'typing_on') {
        this.showTyping();
      } else if (typingStatus === 'typing_off') {
        this.hideTyping();
      }
      // Always return true to prevent "$$$$$TYPING$$$$$" from being rendered as text
      return true;
    }

    // 3. Legacy / Fallback (if any)
    const eventType = msg.type || (msg.event && msg.event.type);
    if (eventType === 'participant_joined') {
      const p = msg.participant || (msg.event && msg.event.participant) || {};
      const name = p.name || 'Agent';
      this.addSystemMessage(`${name} assigned`);
      return true;
    }

    return false;
  }

  addSystemMessage(text) {
    const list = this.shadowRoot.querySelector('.message-list');
    if (!list) return;

    const div = document.createElement('div');
    div.style.textAlign = 'center';
    div.style.color = '#666';
    div.style.fontSize = '12px';
    div.style.margin = '10px 0';
    div.style.fontStyle = 'italic';
    div.textContent = text;

    list.appendChild(div);
    setTimeout(() => list.scrollTop = list.scrollHeight, 0);
  }

  showTyping() {
    if (this.typingIndicator) return;

    const list = this.shadowRoot.querySelector('.message-list');
    if (!list) return;

    const bubble = document.createElement('div');
    bubble.className = 'message incoming typing-indicator';
    bubble.style.padding = '10px 14px';
    bubble.innerHTML = `
        <div class="dots">
          <span>.</span><span>.</span><span>.</span>
        </div>
      `;
    // We can add styles dynamically or assuming they exist. 
    // Let's ensure standard styling matches 'incoming' class but adds animation.

    this.typingIndicator = bubble;
    list.appendChild(bubble);
    setTimeout(() => list.scrollTop = list.scrollHeight, 0);
  }

  hideTyping() {
    if (this.typingIndicator) {
      this.typingIndicator.remove();
      this.typingIndicator = null;
    }
  }
  endConversation() {
    this.addSystemMessage('Conversation ended.');

    // Disable Main Input and Send Button
    const input = this.shadowRoot.querySelector('#chatInput');
    if (input) {
      input.disabled = true;
      input.placeholder = "Conversation ended";
    }

    // Disable Send Button
    const sendBtn = this.shadowRoot.querySelector('.send-btn');
    if (sendBtn) {
      sendBtn.disabled = true;
    }

    // NOTE: We intentionally do NOT disable forms or quick replies that are already rendered,
    // allowing the user to complete any pending actions or feedback.
  }
}

customElements.define('chat-widget', ChatWidget);

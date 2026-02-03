import { WebexClient } from '../api/WebexClient';
import { RealtimeClient } from '../api/RealtimeClient';
import { Localization } from '../i18n';
import { AudioSettingsPanel } from './AudioSettingsPanel';
import { CallManager } from './CallManager';
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
    this.audioSettingsPanel = new AudioSettingsPanel(this);
    this.callManager = new CallManager(this);
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

      // 2. Fetch Threads
      this.threads = await WebexClient.getThreads();
      console.log('Fetched Threads:', this.threads);

      // 3. Auto-Start Check
      const startMsg = this.getAttribute('start-message');
      let autoStarted = false;

      // Auto-start only if there are no existing threads (i.e., new user/session)
      // Prevents starting a new chat on every page reload for returning users.
      if (startMsg && this.threads.length === 0) {
        console.log('Start-message found and no existing threads. Auto-starting...');
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
    } catch (e) {
      console.error('Init error', e);
    }
  }

  // ... (disconnectedCallback, handleMessage remain same)

  disconnectedCallback() {
    this.removeEventListeners();
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

  _handleThemeChange(e) {
    this.isDark = e.matches;
    // Do NOT trigger full render, as it wipes value/state.
    // Instead, update the attribute on md-theme directly.
    const themeEl = this.shadowRoot.querySelector('md-theme');
    if (themeEl) {
      if (this.isDark) {
        themeEl.setAttribute('darkTheme', '');
      } else {
        themeEl.removeAttribute('darkTheme');
      }
    }
  }

  _handleClickOutside(e) {
    if (this.isOpen && e.target !== this) {
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

  _isCallPayload(payload) {
    if (!payload) return false;
    // New Logic: Check type first
    if (payload.type === 'webexcall') return true;
    // Fallback: Check description
    if (payload.description === 'make a call using webex calling') return true;
    return false;
  }

  // ... (disconnectedCallback, handleMessage remain same)

  toggle() {
    this.isOpen = !this.isOpen;
    this.render();
    // Fix: If opening back into an active chat, re-initialize it to load history
    if (this.isOpen && this.view === 'chat' && this.activeThreadId) {
      this.openChat(this.activeThreadId);
    }
  }

  async startSilentChat(message) {
    // Force open
    this.isOpen = true;
    this.render();

    try {
      // 1. Create New Thread
      // 1. Create New Thread
      const newThread = await WebexClient.createThread();
      if (newThread && newThread.id) {
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
      } else {
        console.error('Failed to create thread for auto-start');
      }
      // No TID capture needed


    } catch (e) {
      console.error('Auto-start failed', e);
    }
  }



  render() {
    // 1. Initialize Stable DOM Structure (Once)
    if (!this.shadowRoot.querySelector('#ui-shell')) {
      // Styles
      const progressStyles = `
          #mainFooter { position: relative; }
          .progress-container { width: 100%; height: 4px; background-color: #f0f0f0; position: absolute; top: 0; left: 0; z-index: 10; }
          .progress-bar { width: 0%; height: 100%; background-color: var(--md-sys-color-primary, #0070ad); transition: width 0.1s linear; }
       `;

      // We use a neutral shell (#ui-shell) instead of '.window' to allow different view modes (launcher vs window)
      // style="display: contents" ensures this wrapper doesn't affect the layout (box tree)
      this.shadowRoot.innerHTML = `
          <style>${styles} ${progressStyles}</style>
          <div id="ui-shell" style="display: contents"></div>
          <!-- Persistent Audio Element (Outside of UI shell to survive renders) -->
          <audio id="remote-audio" autoplay playsinline style="display:none;"></audio>
       `;
    }

    const uiShell = this.shadowRoot.querySelector('#ui-shell');

    if (!this.isOpen) {
      // Render Launcher (Neutral Container -> Theme -> Launcher)
      // Note: We do NOT wrap this in .window
      uiShell.innerHTML = `
          <md-theme lumos ${this.isDark ? 'darkTheme' : ''}>
            <div class="launcher-container">
              <md-tooltip message="${this.i18n.t('open_chat')}" placement="left">
                <md-button variant="primary" size="52" circle id="launcherBtn" class="launcher">
                  <md-icon name="chat-active_24"></md-icon>
                </md-button>
              </md-tooltip>
            </div>
          </md-theme>
      `;
      const btn = uiShell.querySelector('#launcherBtn');
      if (btn) btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggle();
      });
      return;
    }

    // Render Full Window
    let contentHtml = '';
    let headerHtml = '';
    let footerHtml = '';

    if (this.view === 'list') {
      headerHtml = `
          <span>${this.i18n.t('my_chats')}</span>
          <md-tooltip message="${this.i18n.t('close')}">
            <button class="icon-btn close-btn" id="closeBtn">
              <md-icon name="cancel_16"></md-icon>
            </button>
          </md-tooltip>
      `;
      const threadsHtml = this.threads
        .filter(t => t && t.id)
        .map(t => `
        <div class="thread-item" data-id="${t.id}">
          <div class="thread-content">
            <div class="thread-header">
              <div class="thread-title">${t.title || this.i18n.t('default_title')}</div>
              <div class="thread-date">${this.formatThreadDate(t.created_on || t.created)}</div>
            </div>
            <div class="thread-footer">
              <div class="thread-preview">
                ${t.last_message || 'No preview available'}
              </div>
              ${t.unread_count ? `
                <div class="unread-badge">
                  ${t.unread_count}
                </div>
              ` : ''}
            </div>
          </div>
        </div>
      `).join('');

      // Simplified Layout: Direct children of .content (flex-col)
      // Custom div list for full control (no shadow DOM nesting issues)
      contentHtml = `
          <div class="content-padded">
             <md-button id="newChatBtn" variant="primary" class="new-chat-btn">${this.i18n.t('start_new_chat')}</md-button>
          </div>
          <div class="thread-list">
            ${threadsHtml}
          </div>
      `;
    } else {
      headerHtml = `
        <div class="header-left">
          <md-tooltip message="${this.i18n.t('back')}">
            <button class="icon-btn back-btn">
               <md-icon name="arrow-left_16"></md-icon>
            </button>
          </md-tooltip>
          <md-tooltip message="${this.i18n.t('download_transcript')}">
            <div class="actions-right"> <!-- Wrapper for spacing -->
              <button class="icon-btn download-btn" id="downloadBtn">
                 <md-icon name="download_16"></md-icon>
              </button>
            </div>
          </md-tooltip>
          <span>${this.i18n.t('chat_header')}</span>
        </div>
        <md-tooltip message="${this.i18n.t('close')}">
          <button class="icon-btn close-btn" id="closeBtn">
            <md-icon name="cancel_16"></md-icon>
          </button>
        </md-tooltip>
      `;
      contentHtml = `
        <div id="loadingSpinner" class="loading-spinner-container">
          <md-spinner size="32"></md-spinner>
        </div>
        <div class="message-list">
        </div>
      `;
      footerHtml = `
        <footer id="mainFooter" class="main-footer">
          <div class="input-row">
            <div id="uploadProgressContainer" class="progress-container hidden">
              <div id="uploadProgressBar" class="progress-bar"></div>
            </div>
            <input type="file" id="fileInput" class="hidden" accept=".jpg,.jpeg,.gif,.png,.mp4,.mp3,.pdf,.docx,.doc,.xls,.xlsx,.csv,.ppt,.pptx,.wav" />
            <md-tooltip message="${this.i18n.t('attachment')}">
              <button class="icon-btn attachment-btn" id="attachmentBtn">
                <md-icon name="attachment_16"></md-icon>
              </button>
            </md-tooltip>
            <md-input id="chatInput" placeholder="${this.i18n.t('input_placeholder')}" shape="pill"></md-input>
      `;

      // Persist Call Controls if active
      setTimeout(() => {
        if (this.callManager && this.callManager.activeCall) {
          console.log('[Debug] Restoring Call Controls after render');
          this.renderCallControls();

          // Restore Timer Logic
          this.resumeCallTimer();

          // Restore Status
          if (this.currentCallStatus) {
            const statusKey = this.currentCallStatus === 'connected' ? 'calling_status_connected' : 'calling_status_dialing';
            const statusText = this.i18n.t(statusKey, this.currentCallStatus);
            this.updateCallStatus(statusText);
          }
        }
      }, 0);

      footerHtml += `
            <md-tooltip message="${this.i18n.t('send_message', 'Send Message')}">
              <md-button class="send-btn" variant="primary" size="32" circle @click="${this.sendMessage}">
                <md-icon name="send_16"></md-icon>
              </md-button>
            </md-tooltip>
          </div>
        </footer>
      `;
    }

    // Render Window (Neutral Container -> .window -> Theme -> View)
    uiShell.innerHTML = `
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
    const closeBtn = uiShell.querySelector('#closeBtn');
    if (closeBtn) closeBtn.addEventListener('click', () => this.toggle());

    if (this.view === 'list') {
      const newChatBtn = uiShell.querySelector('#newChatBtn');
      if (newChatBtn) newChatBtn.addEventListener('click', () => this.createNewChat());
      uiShell.querySelectorAll('.thread-item').forEach(item => {
        item.addEventListener('click', () => this.openChat(item.dataset.id));
      });
    } else {
      const backBtn = uiShell.querySelector('.back-btn');
      if (backBtn) backBtn.addEventListener('click', () => this.showList());
      const sendBtn = uiShell.querySelector('.send-btn');
      if (sendBtn) sendBtn.addEventListener('click', () => this.sendMessage());
      const downloadBtn = uiShell.querySelector('#downloadBtn');
      if (downloadBtn) downloadBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation(); // Prevent closing the widget
        this.downloadTranscript();
      });

      const input = uiShell.querySelector('#chatInput');
      if (input) {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') this.sendMessage();
        });
        input.addEventListener('input-keydown', (e) => {
          if (e.detail.key === 'Enter') this.sendMessage();
        });
      }

      // Attachment Logic
      const fileInput = uiShell.querySelector('#fileInput');
      const attachmentBtn = uiShell.querySelector('#attachmentBtn');

      if (attachmentBtn && fileInput) {
        attachmentBtn.addEventListener('click', () => {
          fileInput.click();
        });

        fileInput.addEventListener('change', (e) => {
          if (e.target.files && e.target.files.length > 0) {
            this.handleFileUpload(e.target.files[0]);
            fileInput.value = '';
          }
        });
      }
    }
  }

  downloadTranscript() {
    const messageList = this.shadowRoot.querySelector('.message-list');
    if (!messageList) return;

    // 1. Clone the message list to avoid modifying the live view
    const clone = messageList.cloneNode(true);

    // 1b. CONVERT FORM DATA TO READ-ONLY PILLS
    // User wants entered data to look like "pills" (similar to Quick Replies), not editable inputs.

    // Select all relevant input types using specific selector for accuracy
    const selector = 'input, textarea, select, md-input';
    const originalInputs = messageList.querySelectorAll(selector);
    const clonedInputs = clone.querySelectorAll(selector);

    originalInputs.forEach((input, i) => {
      const clonedInput = clonedInputs[i];
      if (!clonedInput) return;

      let value = '';
      let shouldConvertToPill = false;

      if (input.tagName === 'MD-INPUT') {
        // Try attribute first (static), then property (dynamic)
        value = input.getAttribute('value') || input.value || '';
        shouldConvertToPill = true;
      } else if (input.tagName === 'TEXTAREA') {
        value = input.value;
        shouldConvertToPill = true;
      } else if (input.tagName === 'SELECT') {
        if (input.selectedIndex >= 0) {
          value = input.options[input.selectedIndex].text;
        }
        shouldConvertToPill = true;
      } else if (input.tagName === 'INPUT') {
        const excludedTypes = ['checkbox', 'radio', 'button', 'submit', 'reset', 'hidden'];
        if (excludedTypes.includes(input.type)) {
          // Keep checkboxes/radios as disabled inputs, verify state
          if (input.checked) {
            clonedInput.setAttribute('checked', 'checked');
            clonedInput.checked = true;
          } else {
            clonedInput.removeAttribute('checked');
            clonedInput.checked = false;
          }
          clonedInput.disabled = true;
        } else {
          value = input.value;
          shouldConvertToPill = true;
        }
      }

      if (shouldConvertToPill) {
        const pill = document.createElement('div');
        pill.className = 'transcript-pill';
        pill.textContent = value;
        clonedInput.replaceWith(pill);
      }
    });

    // 2. Remove "Start Conversation" label or any non-message elements if needed
    const startLabel = clone.querySelector('.start-label');
    if (startLabel) startLabel.remove();

    // 3. Serialize styles
    // We use the imported styles string plus our injected progress styles (or just read from shadowRoot style tag)
    const styleTag = this.shadowRoot.querySelector('style');
    const css = styleTag ? styleTag.textContent : '';

    // 4. Construct HTML
    const html = `
        < !DOCTYPE html >
          <html lang="${this.i18n.locale}">
            <head>
              <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                  <title>${this.i18n.t('chat_header')} - Transcript</title>
                  <style>
        /* Base Reset & Fonts */
          body {
            font-family: 'Inter', sans-serif;
            margin: 0;
            padding: 20px;
            background-color: #f7f7f7;
            color: #121212;
        }


          /* Inject Widget Styles (mapped to :root for variables) */
          ${css.replace(/:host/g, ':root')}

/* CRITICAL OVERRIDES: Reset the fixed widget layout imposed by converting :host to :root */
          :root, body {
            position: relative !important;
            width: 100% !important;
            height: auto !important;
            min-height: 100% !important;
            bottom: auto !important;
            right: auto !important;
            top: auto !important;
            left: auto !important;
            border-radius: 0 !important;
            box-shadow: none !important;
            background-color: #f7f7f7 !important;
            display: block !important;
            overflow: initial !important; /* Allow scrolling */
        }

          /* Ensure message list expands */
          .message-list {
            padding: 20px !important;
            overflow: visible !important;
            height: auto !important;
            max-width: 800px;
            margin: 0 auto;
        }

          /* High Contrast for Forms & Interactions */
          md-button, .qr-button {
            border: 1px solid #ccc !important;
            color: #333 !important;
            opacity: 1 !important;
            border-radius: 999px !important; /* PILL SHAPE */
            padding: 10px 20px !important; /* LARGER PILL */
            display: inline-block !important;
            font-weight: 500 !important;
        }

          md-button[variant="primary"], .qr-button-selected {
            background-color: #0070d2 !important;
            color: white !important;
            border-color: #0070d2 !important;
        }

                    /* Styling for Transcript Pills (formerly inputs) */
                    .transcript-pill {
                      display: inline-block;
                    padding: 10px 20px;
                    border: 1px solid #ccc;
                    border-radius: 999px; /* Pill shape */
                    background-color: #fff;
                    color: #333;
                    font-family: inherit;
                    font-size: 14px;
                    font-weight: 500;
                    margin-top: 4px;
                    box-sizing: border-box;
                    /* Ensure text wraps if super long, or let it grow? Inline-block grows. */
                    max-width: 100%;
                    word-wrap: break-word;
        }

                    /* Make disabled inputs visible (legacy standard inputs like checkboxes) */
                    input:disabled, textarea:disabled, select:disabled {
                      opacity: 1 !important;
                    color: #333 !important;
                    background: transparent !important; /* Cleaner look for checkboxes */
                    border: 1px solid #999 !important;
                    cursor: default;
        }
                  </style>
                </head>
                <body>
                  <div class="message-list">
                    ${clone.innerHTML}
                  </div>
                </body>
              </html>`;

    // 5. Trigger Download
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chat-transcript-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.html`;

    // prevent click from bubbling to document (which closes the widget)
    a.addEventListener('click', (e) => e.stopPropagation());

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async handleFileUpload(file) {
    if (!file) return;

    // Show Progress Bar
    const progressContainer = this.shadowRoot.querySelector('#uploadProgressContainer');
    const progressBar = this.shadowRoot.querySelector('#uploadProgressBar');
    if (progressContainer) progressContainer.style.display = 'block';
    if (progressBar) progressBar.style.width = '0%';

    console.log('Starting upload for:', file.name);

    try {
      const response = await WebexClient.uploadFile(file, (percent) => {
        if (progressBar) progressBar.style.width = `${percent}%`;
      });
      console.log('Upload response received in handleFileUpload:', response);

      // Hide Progress Bar on completion
      if (progressContainer) progressContainer.style.display = 'none';

      // Valid response has code === 0 and message (URL).
      if (response && response.message) {
        // Construct Media Payload
        // Mapping as per confirmation: 
        // Key for URL is derived from response.description (e.g. "file")
        // contentType is also response.description

        const typeKey = response.description || 'file';

        const media = [{
          contentType: typeKey,
          [typeKey]: response.message
        }];

        console.log('Attempting to send attachment message:', media);
        console.log('Current Thread ID:', this.threadId);

        // Send Message
        await this.sendMessage(null, media);
      }
    } catch (e) {
      console.error('File upload failed', e);
      alert(this.i18n.t('upload_failed') || 'Upload failed');
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
      // BUT: We do not employ optimistic UI for Media messages (due to complexity).
      // So we MUST allow outgoing media messages to pass through here to be rendered upon receipt.
      if (isOutgoing && !isHistory && (!media || media.length === 0)) {
        console.log('Skipping outgoing message echo (Text-only):', text);
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

      // --- CORRECT STATE UPDATE ---
      const threadIdToUpdate = (msg.thread && msg.thread.id) || this.activeThreadId;
      let targetThread = null;

      if (threadIdToUpdate) {
        targetThread = this.threads.find(t => t.id === threadIdToUpdate);
      }

      if (targetThread) {
        if (!targetThread.messages) {
          targetThread.messages = [];
        }
        targetThread.messages.push(msg);

        // Update Last Message Preview
        targetThread.last_message = text || (media && media.length ? 'Attachment' : '');

        // Update Unread Count if not active
        // Logic: If I am NOT viewing this specific thread OR I am not in chat view
        const isReading = this.view === 'chat' && this.activeThreadId === targetThread.id;
        if (!isReading && !isOutgoing) {
          targetThread.unread_count = (targetThread.unread_count || 0) + 1;
        }

        // If in List View, refresh to show new preview/badge
        if (this.view === 'list') {
          this.showList();
        }

      } else {
        // Thread not found in local store. 
        console.warn('Received message for unknown thread ID:', threadIdToUpdate);
      }
      // --- END CORRECT STATE UPDATE ---

      if (this.view === 'chat' && this.activeThreadId) {
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

  async handleDeleteThread(threadId) {
    if (!confirm(this.i18n.t('confirm_delete') || 'Delete this conversation?')) return;

    // Optimistic UI update
    this.threads = this.threads.filter(t => t.id !== threadId);
    this.showList(); // Re-render immediately

    try {
      await WebexClient.deleteThread(threadId);
      console.log('Thread deleted:', threadId);
    } catch (e) {
      console.error('Failed to delete thread', e);
      // Optional: Re-fetch or show error (UI is already updated so maybe silent fail is ok for now?)
    }
  }

  async createNewChat() {
    try {
      const newThread = await WebexClient.createThread();

      if (newThread && newThread.id) {
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
      } else {
        console.error('Failed to create thread');
      }
    } catch (e) {
      console.error('Failed to create thread', e);
    }
  }

  async openChat(threadId) {
    this.activeThreadId = threadId;

    // Clear unread count
    const t = this.threads.find(th => th.id === threadId);
    if (t) {
      t.unread_count = 0;
    }

    // Fix: Reset Input Visibility State immediately when opening a chat
    // This prevents state leakage from a previous thread (e.g. hidden input from an active form)
    const footer = this.shadowRoot.querySelector('#mainFooter');
    if (footer) footer.classList.remove('footer-hidden');
    this.view = 'chat';
    this.isOpen = true; // Ensure widget is open
    this.render();

    // Auto-focus immediately
    setTimeout(() => {
      const input = this.shadowRoot.querySelector('#chatInput');
      if (input) input.focus();
    }, 100);

    // Fetch History
    const spinner = this.shadowRoot.querySelector('#loadingSpinner');
    if (spinner) spinner.style.display = 'block';

    try {
      let messages = await WebexClient.fetchHistory(threadId);
      if (spinner) spinner.style.display = 'none';

      // Fix: Ensure messages are sorted Chronologically (Oldest -> Newest)
      // This is CRITICAL for the logic that pairs Questions with subsequent Answers.
      // If the API returns 'Newest First', the loop would process the Answer before the Question, failing to pair them.
      if (messages && messages.length > 0) {
        messages.sort((a, b) => {
          const tA = new Date(a.created || a.created_on || 0).getTime();
          const tB = new Date(b.created || b.created_on || 0).getTime();
          return tA - tB;
        });
      }

      console.log('History loaded, count:', messages ? messages.length : 0);

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
        // Fix: Check 'direction: incoming' (Server sets this for MO messages) to identify User Sent messages in history
        const isFormAnswer = (msg.payload_type === 'sentByUser' || msg.outgoing || msg.direction === 'incoming') &&
          msg.media &&
          msg.media.some(m => m.templateType === 'form');

        // 2. Check if this is a QR ANSWER (User sent, has interactiveData + relatedTid)
        const isQrAnswer = (msg.payload_type === 'sentByUser' || msg.outgoing || msg.direction === 'incoming') &&
          msg.interactiveData &&
          msg.relatedTid;

        if (isFormAnswer) {
          msg.media.forEach(m => {
            if (m.templateType === 'form' && m.templateId) {
              // Look BACKWARDS for the nearest Question with this templateId
              for (let i = index - 1; i >= 0; i--) {
                const diffMsg = messages[i];
                // Must be sentToUser (Question) or simply Incoming, and have same templateId and NOT Answered yet
                const isQuestion = (diffMsg.payload_type === 'sentToUser' || !diffMsg.outgoing) &&
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
        } else if (isQrAnswer || (msg.relatedTid && !msg.interactiveData && msg.payload_type === 'sentByUser')) {
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
                // Fix: Verify if the answer corresponds to a "Webex Call" option.
                // If so, we do NOT want to mark the message as answered (disabled),
                // because "Start Call" buttons should remain enabled/repeatable (per user request).
                const selectedOption = diffMsg.quickReplies.options.find(o => o.identifier === selectedIdentifier);

                if (selectedOption && this._isCallPayload(selectedOption.payload)) {
                  // Do not mark _isAnswered. Do not hide the answer (if any).
                  // We treat "Start Call" interactions as non-terminating.
                  break;
                }

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
        const isQr = msg.payload_type === 'sentToUser' && msg.quickReplies && msg.quickReplies.options && msg.quickReplies.options.length > 0;

        // Check if QR contains a Webex Calling action (should NEVER be hidden as abandoned)
        const isWebexCall = isQr && msg.quickReplies.options.some(opt =>
          this._isCallPayload(opt.payload)
        );

        // If it's a Form/QR, and NOT answered, and NOT the last message... hide it!
        // EXCEPTION: Webex Calling cards are never abandoned
        if ((isForm || isQr) && !msg._isAnswered && index < messages.length - 1 && !isWebexCall) {
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

    // Update Input Visibility based on last message
    this._updateInputVisibility();
  }

  _updateInputVisibility() {
    const footer = this.shadowRoot.querySelector('#mainFooter');
    if (!footer) return;

    let thread = null;

    if (this.activeThreadId) {
      console.log('Visibility: Has activeThreadId', this.activeThreadId);
      thread = this.threads.find(t => t.id === this.activeThreadId);
    }

    // Fallback: If no activeThreadId is set (auto-start quirk), try to find the thread that has the MOST RECENT message
    // This assumes the user is "looking" at the active conversation even if state is slightly desynced
    if (!thread && this.threads.length > 0) {
      // Sort threads by last message time? Or just pick the first one (most recent usually unshifted)
      thread = this.threads[0];
      console.log('Visibility: Fallback to first thread:', thread.id, 'Messages:', thread.messages ? thread.messages.length : 'undefined');
    }

    if (!thread || !thread.messages || thread.messages.length === 0) {
      // console.log('Visibility: Thread invalid or empty, showing footer');
      footer.classList.remove('footer-hidden');
      return;
    }

    // Scan the last few messages (reverse order) to find the latest "meaningful" message
    let lastMsg = null;
    for (let i = thread.messages.length - 1; i >= 0; i--) {
      const m = thread.messages[i];
      if (!m._skipRendering) {
        lastMsg = m;
        break;
      }
    }

    if (!lastMsg) {
      footer.classList.remove('footer-hidden');
      return;
    }

    // Check if the LAST message is an interactive one that blocks input
    // Fix: If direction is 'incoming', it's FROM User TO Platform, so it is NOT 'incoming' to the widget (Bot Message)
    const isIncoming = !lastMsg.outgoing && lastMsg.payload_type !== 'sentByUser' && lastMsg.direction !== 'incoming';
    const isForm = lastMsg.media && lastMsg.media.some(m => m.templateType === 'form');
    const isQr = lastMsg.quickReplies && lastMsg.quickReplies.options && lastMsg.quickReplies.options.length > 0;



    console.log('Visibility Check:', {
      tid: lastMsg.tid,
      isIncoming,
      isForm,
      isQr,
      isAnswered: lastMsg._isAnswered
    });

    console.log('Visibility Check:', {
      tid: lastMsg.tid,
      isIncoming,
      isForm,
      isQr,
      isAnswered: lastMsg._isAnswered,
      footerFound: !!footer,
      lastMsgSub: JSON.stringify(lastMsg).substring(0, 100)
    });


    const chatInput = this.shadowRoot.querySelector('#chatInput');
    const attachmentBtn = this.shadowRoot.querySelector('#attachmentBtn');

    const hasCallOption = isQr && lastMsg.quickReplies.options.some(o =>
      this._isCallPayload(o.payload)
    );

    if (isIncoming && (isForm || (isQr && !hasCallOption)) && !lastMsg._isAnswered) {
      // console.log('Visibility: Hiding footer (Waiting for input)');
      footer.classList.add('footer-hidden');
      if (chatInput) chatInput.disabled = true;
      if (attachmentBtn) attachmentBtn.disabled = true;
    } else {
      // console.log('Visibility: Showing footer');
      const wasHidden = footer.classList.contains('footer-hidden');

      footer.classList.remove('footer-hidden');
      if (chatInput) chatInput.disabled = false;
      if (attachmentBtn) attachmentBtn.disabled = false;

      // Auto-Focus if it just reappeared
      if (wasHidden && chatInput) {
        setTimeout(() => chatInput.focus(), 100);
      }
    }
  }

  async showList() {
    this.view = 'list';
    this.threadId = null;
    this.render();

    // Lazy Fetch Previews for threads missing last_message
    if (this.threads && this.threads.length > 0) {
      this.threads.forEach(async (t) => {
        if (!t.last_message) {
          try {
            // Fetch only 1 message to get the latest
            // Assuming default sort is Newest First or we fetch 100 and pick last/first logic?
            // API usually returns reverse chrono (Newest First) or Chrono (Oldest First).
            // Let's assume fetchHistory returns limited set.
            // CAUTION: fetchHistory sorts by date (Step 6629).

            // To be efficient, we might need a separate 'fetchLastMessage' or just use fetchHistory and take last one.
            const msgs = await WebexClient.fetchHistory(t.id);
            if (msgs && msgs.length > 0) {
              // History is sorted Chronologically (Oldest -> Newest) by our fix in fetchHistory call wrapper? 
              // Wait, openChat does the sorting. fetchHistory just returns raw.
              // Raw API usually returns list. Let's grab the LAST one in the array as latest.
              const last = msgs[msgs.length - 1]; // Assuming Chrono

              // However, if API returns Newest First (likely), then [0] is latest.
              // Let's check timestamps to be sure.
              msgs.sort((a, b) => new Date(b.created_on || 0) - new Date(a.created_on || 0)); // Descending
              const latest = msgs[0];

              t.last_message = latest.message || (latest.media ? '[Media]' : 'No content');

              // Update DOM directly to avoid full re-render flickering
              const previewEl = this.shadowRoot.querySelector(`.thread-item[data-id="${t.id}"] .thread-preview`);
              if (previewEl) {
                previewEl.textContent = t.last_message;
              }
            }
          } catch (e) {
            console.warn('Failed to fetch preview for thread', t.id);
          }
        }
      });
    }
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

    if ((!text && !media) || !this.activeThreadId) {
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

      // Inject language preference into options
      // The user requested to use "options" dict to add "language" key.
      const finalOptions = {
        language: this.i18n ? this.i18n.lang : (navigator.language || 'en'),
        ...options
      };

      const response = await WebexClient.sendMessage(this.activeThreadId, text, media, finalOptions);

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

    // FIX: Hide Outgoing Form Answers (User submitted forms)
    // The content is effectively "merged" into the original form (which becomes disabled).
    if (isOutgoing && hasForm) {
      console.log('Skipping outgoing form answer bubble:', msg.tid);
      return;
    }

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
          // FIX: Removed msg.isHistory === true to allow pending Forms in history to remain interactive
          const isDisabled = isOutgoing || msg._isAnswered;

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

            // Submit on Enter
            input.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') {
                e.preventDefault(); // Prevent newline in textarea or other side effects
                submitForm();
              }
            });
            // Also listen for custom event from md-input if needed, but standard keydown usually works.
            // md-input might shadow DOM, so we might need input-keydown if exposed.
            // Previous code used 'input-keydown' for main chat input. Let's add that too for safety.
            input.addEventListener('input-keydown', (e) => {
              if (e.detail && e.detail.key === 'Enter') {
                submitForm();
              }
            });

            inputs.push(input);
            inputWrapper.appendChild(input);
            formContainer.appendChild(inputWrapper);
          });

          // Submit Logic (Function instead of Button)
          const submitForm = () => {
            // Collect Data
            const formData = inputs.map(input => ({
              name: input.name,
              value: input.value,
              label: input.previousElementSibling ? input.previousElementSibling.textContent : input.name
            }));

            // Validate Mandatory
            const missing = inputs.filter(i => i.required && !i.value);
            if (missing.length > 0) {
              // Determine which attribute validation failed
              // For now, just alert or maybe verify if md-input supports invalid state
              alert(this.i18n.t('fill_required') || 'Please fill required fields');
              return;
            }

            // Send Response
            this.sendMessage(null, [{
              templateType: 'form',
              templateId: m.templateId,
              contentType: 'template',
              payload: { fields: formData }
            }]);

            // Disable Form locally
            inputs.forEach(i => i.disabled = true);

            // Fix: Update the original message in the store, not just the local copy
            // The `msg` object here is a copy passed to addMessageToUI
            if (this.threads) {
              for (const t of this.threads) {
                if (t.messages) {
                  const originalMsg = t.messages.find(m => m.tid === msg.tid);
                  if (originalMsg) {
                    originalMsg._isAnswered = true;
                    break;
                  }
                }
              }
            } else {
              // Fallback if strictly active thread needed (less robust)
              msg._isAnswered = true;
            }

            this._updateInputVisibility();


            // Refocus Main Chat Input
            setTimeout(() => {
              const mainInput = this.shadowRoot.querySelector('#chatInput');
              if (mainInput) mainInput.focus();
            }, 100);
          };

          // Auto-focus first input on render
          if (!isDisabled && inputs.length > 0) {
            setTimeout(() => {
              inputs[0].focus();
            }, 300); // Slight delay for rendering
          }



          item.appendChild(formContainer);
        } else {
          // RENDER OTHER MEDIA (Image, Video, File)
          const type = m.contentType || m.mimeType || '';
          let url = m.url || m.contentUrl || (m.payload && m.payload.url);

          // Handle dynamic key mapping from upload response (e.g. m.file, m.image)
          if (!url && type && m[type]) {
            url = m[type];
          }

          if (!url && m.file) {
            if (typeof m.file === 'string') {
              url = m.file;
            } else if (m.file.url) {
              url = m.file.url;
            }
          }

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

          }


          if (type === 'location' || (m.latitude && m.longitude) || (m.payload && m.payload.latitude)) {
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

            const link = document.createElement('a');
            link.href = url || '#';
            link.textContent = '📄 ' + this._deriveFileName(url, m.fileName || m.filename);
            link.target = '_blank'; // Open in new tab
            link.className = 'file-link';

            // Fix: Stop propagation to prevent "click outside" handler from closing the widget
            link.addEventListener('click', (e) => {
              e.stopPropagation();
              if (!url || url === '#' || url === 'undefined') {
                e.preventDefault();
                console.error('Invalid file URL:', url, m);
              }
            });

            fileContainer.appendChild(link);
            item.appendChild(fileContainer);
          }
        }
      });
    }

    // Special Handling: Webex Calling Payload
    // Check msg.payload OR msg.event.payload for history support
    const payload = msg.payload || (msg.event && msg.event.payload);

    if (this._isCallPayload(payload) && payload.destination && payload.accessToken) {
      console.log('Rendering Webex Calling Card');
      const callContainer = document.createElement('div');
      callContainer.className = 'webex-call-card';
      // Basic styling - consider moving to CSS
      callContainer.style.marginTop = '10px';
      callContainer.style.padding = '12px';
      callContainer.style.backgroundColor = 'var(--md-sys-color-surface-container-low, #f7f7f7)';
      callContainer.style.borderRadius = '12px';
      callContainer.style.border = '1px solid var(--md-sys-color-outline-variant, #e0e0e0)';
      callContainer.style.display = 'flex';
      callContainer.style.flexDirection = 'column';
      callContainer.style.alignItems = 'center';
      callContainer.style.gap = '8px';

      const label = document.createElement('div');
      label.textContent = 'Incoming Call Request';
      label.style.fontSize = '12px';
      label.style.fontWeight = '600';
      label.style.color = 'var(--md-sys-color-on-surface, #1e1e1e)';

      const btn = document.createElement('md-button');
      btn.variant = 'primary';

      const btnIcon = document.createElement('md-icon');
      btnIcon.setAttribute('slot', 'icon');
      btnIcon.name = 'handset_16';
      btn.appendChild(btnIcon);

      btn.textContent = this.i18n.t('start_call');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        console.log('Starting Call to:', payload.destination);
        // Strict: Use only the token from the payload
        this.startWebexCall(payload);
      });

      // callContainer.appendChild(icon); // Removed separate icon
      callContainer.appendChild(label);
      callContainer.appendChild(btn);
      item.appendChild(callContainer);
    }

    if (msg.quickReplies && msg.quickReplies.options && Array.isArray(msg.quickReplies.options)) {
      console.log('Rendering Quick Replies. isAnswered:', msg._isAnswered, 'TID:', msg.tid);
      const qrContainer = document.createElement('div');
      qrContainer.className = 'qr-container';

      msg.quickReplies.options.forEach(opt => {
        // Special Handling: Webex Calling Payload inside QR
        if (this._isCallPayload(opt.payload) && opt.payload.destination && opt.payload.accessToken) {
          console.log('Rendering Webex Calling Card (QR Option)');

          const btn = document.createElement('md-button');
          btn.variant = 'primary';
          btn.size = '28';

          const btnIcon = document.createElement('md-icon');
          btnIcon.style.marginRight = '8px';
          btnIcon.name = 'handset_16';
          btn.appendChild(btnIcon);

          // Append text node safely
          btn.appendChild(document.createTextNode(this.i18n.t('start_call')));
          btn.className = 'qr-button'; // Keep standard class for layout

          if (msg._isAnswered) {
            btn.disabled = true;
            btn.classList.add('disabled'); // Ensure visual styling
          }

          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (msg._isAnswered) return; // Prevent action if answered

            console.log('Starting Call to:', opt.payload.destination);
            // Strict: Use only the token from the payload
            this.startWebexCall(opt.payload);
          });

          // Append directly to QR Container
          qrContainer.appendChild(btn);
          return; // Skip standard button rendering for this option
        }

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
        } else if (isOutgoing) {
          // Only disable if it's strictly an outgoing message (bot shouldn't have buttons usually, but safe guard)
          // WE REMOVED msg.isHistory check to allow pending QRs in history to remain interactive
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

    // Update Visibility (e.g. if new message is Form/QR, hide input)
    this._updateInputVisibility();
  }

  _deriveFileName(url, fallback) {
    if (!url) return fallback || 'Download File';
    try {
      // 1. Extract basename from URL (remove query params)
      const cleanUrl = url.split('?')[0];
      const parts = cleanUrl.split('/');
      let filename = parts[parts.length - 1];

      // 2. Decode URI component if needed (e.g. %20)
      filename = decodeURIComponent(filename);

      // 3. Strip UUID suffix (format: _UUID)
      // Matches _[UUID] followed by .extension or end of string
      const uuidRegex = /_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=(\.[a-z0-9]+)?$)/i;

      filename = filename.replace(uuidRegex, '');

      return filename || fallback || 'Download File';
    } catch (e) {
      return fallback || 'Download File';
    }
  }

  formatThreadDate(timestamp) {
    if (!timestamp) return '';
    try {
      const date = new Date(timestamp);
      const now = new Date();
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);

      const isToday = date.getDate() === now.getDate() &&
        date.getMonth() === now.getMonth() &&
        date.getFullYear() === now.getFullYear();

      const isYesterday = date.getDate() === yesterday.getDate() &&
        date.getMonth() === yesterday.getMonth() &&
        date.getFullYear() === yesterday.getFullYear();

      const timeStr = new Intl.DateTimeFormat(navigator.language, {
        hour: '2-digit',
        minute: '2-digit'
      }).format(date);

      if (isToday) {
        return `${this.i18n.t('today')}, ${timeStr}`;
      } else if (isYesterday) {
        return `${this.i18n.t('yesterday')}, ${timeStr}`;
      } else {
        return new Intl.DateTimeFormat(navigator.language, {
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        }).format(date);
      }
    } catch (e) {
      return '';
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
    // Format: message: "$$$$$AGENTASSIGNED$$$$$", extras: {customtags: {agent: "Alice" } }
    if (msg.message === '$$$$$AGENTASSIGNED$$$$$') {
      const agentName = (msg.extras && msg.extras.customtags && msg.extras.customtags.agent) || 'Agent';
      this.addSystemMessage(`${agentName} assigned`);
      return true;
    }

    // 2. Typing Events
    // Format: message: "$$$$$TYPING$$$$$", extras: {customtags: {typing: "typing_on" | "typing_off" } }
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


  // ==========================================
  // Webex Calling Integration
  // ==========================================

  async startWebexCall(payload) {
    if (this.callManager) {
      this.currentCallStatus = null; // Reset status on new call attempt
      await this.callManager.startWebexCall(payload);
    }
  }

  handleRemoteAudio(stream) {
    if (this.callManager) {
      this.callManager.handleRemoteAudio(stream);
    }
  }

  renderCallControls() {
    const footer = this.shadowRoot.querySelector('#mainFooter');
    if (!footer) return;

    let controls = this.shadowRoot.querySelector('.call-controls');
    if (controls) return; // Already exists

    controls = document.createElement('div');
    controls.className = 'call-controls';
    controls.id = 'call-controls';

    // Calculate initial status text
    const statusKey = this.currentCallStatus === 'connected' ? 'calling_status_connected' : 'calling_status_dialing';
    // Fallback if status is undefined/initializing
    const statusText = this.currentCallStatus ? this.i18n.t(statusKey, this.currentCallStatus) : this.i18n.t('calling_status_initializing', 'Initializing...');

    controls.innerHTML = `
        <div class="call-status" title="${statusText}">
          <span class="call-timer">00:00 </span>
          <span class="status-label">${statusText}</span>
        </div>
        <div class="call-actions">
          <md-tooltip message="${this.i18n.t('audio_settings', 'Audio Settings')}">
             <md-button id="btn-audio-settings" variant="secondary" size="32" circle aria-label="${this.i18n.t('audio_settings', 'Audio Settings')}">
               <md-icon name="settings_16" class="control-icon"></md-icon>
             </md-button>
          </md-tooltip>

          <md-tooltip message="${this.i18n.t('mute')}" id="tooltip-mute">
            <md-button id="btn-mute" variant="secondary" size="32" circle aria-label="${this.i18n.t('mute')}">
              <md-icon name="microphone-on_24" class="control-icon"></md-icon>
            </md-button>
          </md-tooltip>
          
          <md-tooltip message="${this.i18n.t('end_call')}">
             <md-button id="btn-hangup" variant="secondary" size="32" circle aria-label="${this.i18n.t('end_call')}">
               <md-icon name="cancel_24" class="control-icon"></md-icon>
             </md-button>
          </md-tooltip>
        </div>
    `;

    // PREPEND to footer. Since footer is column, it sits on top.
    footer.insertBefore(controls, footer.firstChild);

    // Add class for potential parent styling adjustments
    footer.classList.add('has-active-call');

    // Bind Events
    controls.querySelector('#btn-hangup').addEventListener('click', () => {
      if (this.callManager) this.callManager.hangupCall();
    });
    controls.querySelector('#btn-mute').addEventListener('click', () => {
      if (this.callManager) this.callManager.toggleMute();
    });
    controls.querySelector('#btn-audio-settings').addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.audioSettingsPanel) this.audioSettingsPanel.toggle();
    });
  }



  updateCallStatus(status) {
    const el = this.shadowRoot.querySelector('.status-label');
    if (el) {
      el.textContent = status;
      // Also update title on parent for tooltip behavior
      const parent = this.shadowRoot.querySelector('.call-status');
      if (parent) parent.title = status;
    }
  }

  _handleCallConnected() {
    if (this._isConnected) return; // Debounce
    this._isConnected = true;
    console.log('[Debug] Handling Call Connected State');
    this.updateCallStatus(this.i18n.t('calling_status_connected', 'Connected'));
    this.setCallControlsState('connected');
    this.startCallTimer();
    this.currentCallStatus = 'connected';
  }

  setCallControlsState(state) {
    // Enable/Disable buttons based on state
  }

  startCallTimer() {
    this.callStartTime = Date.now();
    this.resumeCallTimer();
  }

  resumeCallTimer() {
    // If interval already runs, do nothing (or clear and restart to ensure UI binding?)
    if (this.callTimerInterval) clearInterval(this.callTimerInterval);

    if (!this.callStartTime) this.callStartTime = Date.now(); // Fallback

    const updateUI = () => {
      const delta = Math.floor((Date.now() - this.callStartTime) / 1000);
      const min = String(Math.floor(delta / 60)).padStart(2, '0');
      const sec = String(delta % 60).padStart(2, '0');
      const el = this.shadowRoot.querySelector('.call-timer');
      if (el) el.textContent = `${min}:${sec} `;
    };

    updateUI(); // Immediate update
    this.callTimerInterval = setInterval(updateUI, 1000);
  }

  stopCallTimer() {
    if (this.callTimerInterval) clearInterval(this.callTimerInterval);
    this.callTimerInterval = null;
  }

  async hangupCall() {
    if (this.callManager) {
      await this.callManager.hangupCall();
    }
  }

  async endWebexCall() {
    if (this.callManager) {
      await this.callManager.endWebexCall();
    }
  }




}

customElements.define('chat-widget', ChatWidget);

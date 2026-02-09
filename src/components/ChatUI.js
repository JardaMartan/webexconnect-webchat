import styles from './chat-widget.css?inline';

// Styles for progress bar moved to css

export class ChatUI {
    constructor(widget, shadowRoot) {
        this.widget = widget;
        this.shadowRoot = shadowRoot;
        this.typingIndicator = null;
        this.callTimerInterval = null;
        this.callStartTime = null;
    }

    get i18n() {
        return this.widget.i18n;
    }

    render(isOpen, view, isDark, threads, isLoading = false) {
        // 1. Initialize Stable DOM Structure (Once)
        if (!this.shadowRoot.querySelector('#ui-shell')) {
            // We use a neutral shell (#ui-shell) instead of '.window' to allow different view modes (launcher vs window)
            // 'ui-shell' class handles display: contents
            this.shadowRoot.innerHTML = `
          <style>${styles}</style>
          <div id="ui-shell" class="ui-shell"></div>
          <!-- Persistent Audio Element (Outside of UI shell to survive renders) -->
          <audio id="remote-audio" class="remote-audio" autoplay playsinline></audio>
       `;
        }

        const uiShell = this.shadowRoot.querySelector('#ui-shell');

        // LAUNCHER MODE
        if (!isOpen) {
            if (uiShell.querySelector('.launcher-container')) {
                // Already rendered launcher, update theme only
                const theme = uiShell.querySelector('md-theme');
                if (theme) {
                    if (isDark) theme.setAttribute('darkTheme', '');
                    else theme.removeAttribute('darkTheme');
                }
                return;
            }
            // Render Launcher (Neutral Container -> Theme -> Launcher)
            uiShell.innerHTML = `
          <md-theme lumos ${isDark ? 'darkTheme' : ''}>
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
                this.widget.toggle();
            });
            return;
        }

        // WINDOW MODE
        const currentWindow = uiShell.querySelector('.window');
        const isCurrentlyListView = currentWindow && uiShell.querySelector('#newChatBtn');
        const isCurrentlyChatView = currentWindow && !isCurrentlyListView;
        const targetIsListView = view === 'list';

        // Check if we can do a smart update (prevent DOM destruction)
        if (currentWindow && ((targetIsListView && isCurrentlyListView) || (!targetIsListView && isCurrentlyChatView))) {
            console.log('[Debug] Smart Render: Updating visible state only. isLoading:', isLoading);

            // Update Theme
            const theme = uiShell.querySelector('md-theme');
            if (theme) {
                if (isDark) theme.setAttribute('darkTheme', '');
                else theme.removeAttribute('darkTheme');
            }

            // Update Spinner (Chat View Only)
            if (!targetIsListView) {
                const spinnerContainer = uiShell.querySelector('#loadingSpinner');
                if (spinnerContainer) {
                    if (isLoading) spinnerContainer.classList.add('visible-flex');
                    else spinnerContainer.classList.remove('visible-flex');
                }

                // Also ensure footer visibility is correct
                this.updateInputVisibility();
            }
            return;
        }

        // Render Full Window
        let contentHtml = '';
        let headerHtml = '';
        let footerHtml = '';

        if (view === 'list') {
            headerHtml = `
          <span>${this.i18n.t('my_chats')}</span>
          <md-tooltip message="${this.i18n.t('close')}">
            <button class="icon-btn close-btn" id="closeBtn">
              <md-icon name="cancel_16"></md-icon>
            </button>
          </md-tooltip>
      `;
            const threadsHtml = threads
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
            // Using class for spinner visibility
            contentHtml = `
        <div id="loadingSpinner" class="loading-spinner-container ${isLoading ? 'visible-flex' : ''} ">
          <md-spinner size="32"></md-spinner>
        </div>
        <div class="message-list">
        </div>
      `;
            // Using classes for progress bar
            footerHtml = `
        <footer id="mainFooter" class="main-footer">
          <div id="uploadProgressContainer" class="progress-container">
            <div id="uploadProgressBar" class="progress-bar"></div>
          </div>
          <div class="input-row">
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
                if (this.widget.callManager && this.widget.callManager.activeCall) {
                    console.log('[Debug] Restoring Call Controls after render');
                    this.renderCallControls(this.widget.currentCallStatus);

                    // Restore Timer Logic
                    this.resumeCallTimer();
                }
            }, 0);

            footerHtml += `
            <md-tooltip message="${this.i18n.t('send_message', 'Send Message')}">
              <md-button class="send-btn" variant="primary" size="32" circle>
                <md-icon name="send_16"></md-icon>
              </md-button>
            </md-tooltip>
          </div>
        </footer>
      `;
        }

        // Render Window (Neutral Container -> .window -> Theme -> View)
        console.log('[Debug] ChatUI render called. view:', view, 'isLoading:', isLoading);
        uiShell.innerHTML = `
        <div class="window">
          <md-theme lumos ${isDark ? 'darkTheme' : ''}>
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
        if (closeBtn) closeBtn.addEventListener('click', () => this.widget.toggle());

        if (view === 'list') {
            const newChatBtn = uiShell.querySelector('#newChatBtn');
            if (newChatBtn) newChatBtn.addEventListener('click', () => this.widget.createNewChat());
            uiShell.querySelectorAll('.thread-item').forEach(item => {
                item.addEventListener('click', () => this.widget.openChat(item.dataset.id));
            });
        } else {
            const backBtn = uiShell.querySelector('.back-btn');
            if (backBtn) backBtn.addEventListener('click', () => this.widget.showList());
            const sendBtn = uiShell.querySelector('.send-btn');
            if (sendBtn) sendBtn.addEventListener('click', () => this.widget.sendMessage());
            const downloadBtn = uiShell.querySelector('#downloadBtn');
            if (downloadBtn) downloadBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation(); // Prevent closing the widget
                this.downloadTranscript();
            });

            const input = uiShell.querySelector('#chatInput');
            if (input) {
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') this.widget.sendMessage();
                });
                input.addEventListener('input-keydown', (e) => {
                    if (e.detail.key === 'Enter') this.widget.sendMessage();
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
                        this.widget.handleFileUpload(e.target.files[0]);
                        fileInput.value = '';
                    }
                });
            }
        }
    }

    hasMessage(id) {
        if (!id) return false;
        // Check both data-id and data-client-id
        return this.shadowRoot.querySelector(`.msg-container[data-id="${id}"]`) ||
            this.shadowRoot.querySelector(`.msg-container[data-client-message-id="${id}"]`);
    }

    addMessage(msg, isOutgoing, isHistory = false) {
        // console.log('[Debug] addMessage called. outgoing:', isOutgoing, 'history:', isHistory, 'msg:', msg);
        const list = this.shadowRoot.querySelector('.message-list');
        if (!list) {
            console.error('[Debug] Message list not found in ShadowDOM!');
            return;
        }

        // Check availability of required data
        const text = msg.message || (msg.event && msg.event.message && msg.event.message.text);
        const media = msg.media; // Array of media objects

        // Create Bubble
        const item = document.createElement('div');
        item.className = isOutgoing ? 'bubble outgoing' : 'bubble incoming';

        if (text) {
            const textSpan = document.createElement('span');
            // Handle Newlines
            textSpan.innerHTML = text.replace(/\n/g, '<br/>');
            item.appendChild(textSpan);
        }

        if (media && media.length > 0) {
            media.forEach(m => {
                const type = m.contentType || m.mimeType || '';
                let url = m.url || m.contentUrl || (m.payload && m.payload.url);

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

                    link.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (!url || url === '#' || url === 'undefined') {
                            e.preventDefault();
                            console.error('Invalid file URL:', url, m);
                        }
                    });

                    fileContainer.appendChild(link);
                    item.appendChild(fileContainer);
                } else if (type === 'template' || m.contentType === 'template' || m.templateType === 'form') {
                    // Form / Template Rendering
                    const payload = m.payload;
                    if (payload && payload.fields) {
                        const formContainer = document.createElement('div');
                        formContainer.className = 'chat-media-form';
                        // User requested no special styling for the container

                        if (payload.title) {
                            const title = document.createElement('div');
                            title.textContent = payload.title;
                            title.className = 'chat-media-form-title';
                            formContainer.appendChild(title);
                        }

                        const inputs = [];

                        // Helper to Toggle Main Input
                        const toggleMainInput = (show) => {
                            const footer = this.shadowRoot.querySelector('footer');
                            if (footer) {
                                if (show) {
                                    footer.classList.remove('footer-hidden');
                                } else {
                                    footer.classList.add('footer-hidden');
                                }
                            }
                            if (show) {
                                setTimeout(() => {
                                    const mainInput = this.shadowRoot.querySelector('#chatInput');
                                    if (mainInput) mainInput.focus();
                                }, 50);
                            }
                        };

                        // Logic to run when form is displayed (only if not answered)
                        if (!msg._isAnswered) {
                            // Hide main input
                            toggleMainInput(false);
                        }

                        const submitForm = () => {
                            const values = {};
                            let valid = true;

                            inputs.forEach(inp => {
                                const val = inp.value;
                                const isRequired = inp.hasAttribute('required') || inp.required;

                                if (isRequired && (!val || !val.trim())) {
                                    // md-input might support invalid state or message
                                    inp.setAttribute('message-arr', JSON.stringify([{ message: 'Required', type: 'error' }]));
                                    // Use class for validation error
                                    inp.classList.add('input-error');
                                    valid = false;
                                } else {
                                    inp.removeAttribute('message-arr');
                                    inp.classList.remove('input-error');
                                    values[inp.getAttribute('name')] = val;
                                }
                            });

                            if (valid && this.widget) {
                                // 1. Lock UI
                                inputs.forEach(inp => {
                                    inp.disabled = true;
                                    inp.setAttribute('disabled', '');
                                });

                                // 2. Send Message (skipUI = true to avoid echo bubble)
                                const textResponse = Object.values(values).join(' ');
                                console.log('Submitting form with legacy payload structure:', values);

                                // Construct legacy-style media payload
                                // We need to send back the EXACT structure we received, but with 'value' populated in fields.
                                // 1. Deep copy the original payload
                                const responsePayload = JSON.parse(JSON.stringify(payload));

                                // 2. Fill in values
                                if (responsePayload.fields) {
                                    responsePayload.fields.forEach(f => {
                                        if (values[f.name] !== undefined) {
                                            f.value = values[f.name];
                                        }
                                    });
                                }

                                // 3. Wrap in media array
                                const media = [{
                                    contentType: "template",
                                    templateType: "form",
                                    templateId: m.templateId,
                                    payload: responsePayload
                                }];

                                // 2. Send Message (skipUI = true to avoid echo bubble RE-RENDERING the form)
                                this.widget.sendMessage(textResponse, media, {
                                    relatedTid: msg.tid
                                }, true); // skipUI: true

                                // User requested to NOT show the text response bubble, as the form itself shows values.
                                // Removed this.addMessage(...)

                                // 3. Mark as answered locally (if supported)
                                msg._isAnswered = true;

                                // 4. Restore Main Input
                                toggleMainInput(true);
                            }
                        };

                        payload.fields.forEach((field, index) => {
                            const fieldWrapper = document.createElement('div');
                            fieldWrapper.className = 'chat-media-form-field';

                            const label = document.createElement('label');
                            label.textContent = field.label + (field.mandatory ? ' *' : '');
                            label.className = 'chat-media-form-label';
                            fieldWrapper.appendChild(label);

                            const input = document.createElement('md-input');
                            input.setAttribute('type', field.type || 'text');
                            input.setAttribute('name', field.name);
                            input.setAttribute('placeholder', field.description || '');
                            input.setAttribute('shape', 'pill');
                            input.className = 'chat-media-form-input';

                            // Check if previously answered
                            if (msg._isAnswered) {
                                input.setAttribute('disabled', '');

                                // Populate value if available from history pre-processing
                                if (msg._submittedValues && msg._submittedValues[field.name]) {
                                    input.value = msg._submittedValues[field.name];
                                    // md-input might need value attribute for initial render validation?
                                    input.setAttribute('value', msg._submittedValues[field.name]);
                                }
                            }

                            if (field.mandatory) {
                                input.setAttribute('required', '');
                            }

                            // Enter to Submit
                            const handleEnter = (e) => {
                                const key = e.key || (e.detail && e.detail.key);
                                if (key === 'Enter') {
                                    e.preventDefault();
                                    submitForm();
                                }
                            };

                            input.addEventListener('keydown', handleEnter);
                            input.addEventListener('input-keydown', handleEnter);

                            fieldWrapper.appendChild(input);
                            formContainer.appendChild(fieldWrapper);
                            inputs.push(input);
                        });

                        item.appendChild(formContainer);

                        // Auto-focus first input if active and NOT history
                        if (!msg._isAnswered && !isHistory && inputs.length > 0) {
                            setTimeout(() => {
                                inputs[0].focus();
                            }, 100);
                        }
                    }
                }
            });
        }

        // Webex Calling Card
        const payload = msg.payload || (msg.event && msg.event.payload);

        if (this._isCallPayload(payload) && payload.destination && payload.accessToken) {
            console.log('Rendering Webex Calling Card');
            const callContainer = document.createElement('div');
            callContainer.className = 'webex-call-card';

            const label = document.createElement('div');
            label.textContent = 'Incoming Call Request';
            label.className = 'webex-call-card-label';

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
                if (this.widget) {
                    // Local Echo Only for Webex Card to avoid "New Chat" NLU trigger
                    this.addMessage({
                        message: this.i18n.t('start_call'),
                        outgoing: true,
                        created: Date.now(),
                        payload_type: 'sentByUser'
                    }, true, false);
                    this.widget.startWebexCall(payload);
                }
            });

            callContainer.appendChild(label);
            callContainer.appendChild(btn);
            item.appendChild(callContainer);
        }

        // Quick Replies
        if (msg.quickReplies && msg.quickReplies.options && Array.isArray(msg.quickReplies.options)) {
            console.log('Rendering Quick Replies. isAnswered:', msg._isAnswered, 'TID:', msg.tid);
            const qrContainer = document.createElement('div');
            qrContainer.className = 'qr-container';

            msg.quickReplies.options.forEach(opt => {
                if (this._isCallPayload(opt.payload) && opt.payload.destination && opt.payload.accessToken) {
                    const btn = document.createElement('md-button');
                    btn.variant = 'primary';
                    btn.size = '28';

                    const btnIcon = document.createElement('md-icon');
                    btnIcon.className = 'qr-btn-icon';
                    btnIcon.name = 'handset_16';
                    btn.appendChild(btnIcon);

                    // Use title from option if available, else translation
                    const btnText = opt.title || this.i18n.t('start_call');
                    btn.appendChild(document.createTextNode(btnText));
                    btn.className = 'qr-button qr-button-call'; // Tag as special

                    // Call button is ALWAYS enabled per user request
                    btn.disabled = false;
                    btn.removeAttribute('disabled');

                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        // Check if disabled (attribute or property)
                        if (btn.disabled || btn.hasAttribute('disabled')) {
                            return;
                        }
                        // Call Button ignores _isAnswered state to allow calling from history
                        // if (msg._isAnswered) return;

                        console.log('Starting Call to:', opt.payload.destination);
                        if (this.widget) {
                            // Construct Interactive Data for valid QR response
                            const interactiveData = {
                                type: opt.type || "quickReplyPostback",
                                identifier: opt.identifier || "call",
                                payload: opt.payload || {},
                                title: opt.title || btn.textContent,
                                reference: msg.quickReplies.reference || "service",
                                url: opt.url || ""
                            };

                            // Send as proper generic attachment/QR response
                            this.widget.sendMessage(btnText, null, {
                                relatedTid: msg.tid,
                                interactiveData: interactiveData
                            }, true); // skipUI: true, user requested no echo

                            this.widget.startWebexCall(opt.payload);
                        }
                    });



                    qrContainer.appendChild(btn);
                    return;
                }

                const btn = document.createElement('md-button');
                btn.variant = 'secondary';
                btn.size = '28';
                btn.textContent = opt.title;
                btn.className = 'qr-button';

                const highlightSelected = (button) => {
                    button.setAttribute('variant', 'primary');
                    button.removeAttribute('disabled');
                    button.disabled = false; // Property
                    button.classList.add('qr-button-selected');
                };

                if (msg._isAnswered) {
                    if (opt.identifier == msg._selectedIdentifier) {
                        highlightSelected(btn);
                    } else {
                        btn.disabled = true;
                        btn.setAttribute('disabled', '');
                    }
                } else if (isOutgoing) {
                    btn.disabled = true;
                    btn.setAttribute('disabled', '');
                } else {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();

                        // preventing re-click if already disabled
                        if (btn.disabled || btn.hasAttribute('disabled')) {
                            return;
                        }
                        if (msg._isAnswered) return;

                        const interactiveData = {
                            type: opt.type || "quickReplyPostback",
                            identifier: opt.identifier,
                            payload: opt.payload || {},
                            title: opt.title,
                            reference: msg.quickReplies.reference || "service",
                            url: opt.url || ""
                        };

                        if (this.widget) {
                            this.widget.trackQRClick(opt.title);
                            this.widget.sendMessage(opt.title, null, {
                                relatedTid: msg.tid,
                                interactiveData: interactiveData
                            }, true);
                        }

                        msg._isAnswered = true;
                        msg._selectedIdentifier = opt.identifier;

                        Array.from(qrContainer.children).forEach(b => {
                            if (b.classList.contains('qr-button-call')) return; // Skip call button

                            if (b === btn) {
                                highlightSelected(b);
                            } else {
                                b.disabled = true;
                                b.setAttribute('disabled', '');
                            }
                        });
                    });
                }
                qrContainer.appendChild(btn);
            });
            item.appendChild(qrContainer);
        }

        if (item.hasChildNodes()) {
            const container = document.createElement('div');
            container.className = isOutgoing ? 'msg-container outgoing' : 'msg-container incoming';

            // Set data attributes for deduplication
            if (msg.tid) container.dataset.tid = msg.tid;
            if (msg.id) container.dataset.id = msg.id;

            // Handle clientMessageId from various sources
            const cmid = msg.clientMessageId || (msg.extras && msg.extras.clientMessageId);
            if (cmid) container.dataset.clientMessageId = cmid;

            container.appendChild(item);

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

        // Update Visibility
        this.updateInputVisibility();
    }

    markAsAnswered(tid, interactiveData) {
        if (!tid) return;

        const bubbles = this.shadowRoot.querySelectorAll('.msg-container');
        let found = false;

        bubbles.forEach(b => {
            // Loose comparison in case of string/number diffs
            if (b.dataset.tid == tid) {
                found = true;
                const buttons = b.querySelectorAll('.qr-button');

                buttons.forEach(btn => {
                    // Skip Call Button
                    if (btn.classList.contains('qr-button-call')) {
                        return;
                    }

                    // Match by Title (text content) primarily
                    // normalize both
                    const btnText = (btn.textContent || '').trim().toLowerCase();
                    const targetTitle = (interactiveData && interactiveData.title || '').trim().toLowerCase();

                    const isMatch = btnText === targetTitle;

                    if (interactiveData && isMatch) {
                        btn.classList.add('qr-button-selected');
                        btn.setAttribute('variant', 'primary');
                        btn.removeAttribute('disabled');
                        btn.disabled = false;
                    } else {
                        btn.setAttribute('disabled', '');
                        btn.disabled = true;
                    }
                });
            }
        });

        if (!found) {
            console.warn('[Debug] markAsAnswered: Could not find bubble with TID:', tid);
        }
    }

    updateInputVisibility() {
        const footer = this.shadowRoot.querySelector('#mainFooter');
        if (!footer) return;

        let thread = null;
        if (this.widget.activeThreadId) {
            if (this.widget.threads) {
                thread = this.widget.threads.find(t => t.id === this.widget.activeThreadId);
            }
        }

        if (!thread && this.widget.threads && this.widget.threads.length > 0) {
            thread = this.widget.threads[0];
        }

        if (!thread || !thread.messages || thread.messages.length === 0) {
            footer.classList.remove('footer-hidden');
            return;
        }

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

        const isIncoming = !lastMsg.outgoing && lastMsg.payload_type !== 'sentByUser';
        const isForm = lastMsg.media && lastMsg.media.some(m => m.templateType === 'form');
        const isQr = lastMsg.quickReplies && lastMsg.quickReplies.options && lastMsg.quickReplies.options.length > 0;

        const chatInput = this.shadowRoot.querySelector('#chatInput');
        const attachmentBtn = this.shadowRoot.querySelector('#attachmentBtn');

        const hasCallOption = isQr && lastMsg.quickReplies.options.some(o =>
            this._isCallPayload(o.payload)
        );

        const shouldHideForQr = isQr && !lastMsg._isAnswered && !hasCallOption;
        const shouldHideForForm = isIncoming && isForm && !lastMsg._isAnswered;

        if (shouldHideForQr || shouldHideForForm) {
            footer.classList.add('footer-hidden');
            if (chatInput) chatInput.disabled = true;
            if (attachmentBtn) attachmentBtn.disabled = true;
        } else {
            footer.classList.remove('footer-hidden');
            if (chatInput) chatInput.disabled = false;
            if (attachmentBtn) attachmentBtn.disabled = false;

            this.focusInput();
        }
    }

    focusInput() {
        const chatInput = this.shadowRoot.querySelector('#chatInput');
        if (!chatInput || chatInput.disabled) return;

        chatInput.focus();

        // Handle Momentum Web Components if present
        if (chatInput.shadowRoot) {
            const innerInput = chatInput.shadowRoot.querySelector('input');
            if (innerInput) innerInput.focus();
        }

        // Dispatch specific event for components relying on it
        chatInput.dispatchEvent(new Event('focus'));

        // Retry after a short delay to account for transitions
        setTimeout(() => {
            if (!chatInput.disabled) chatInput.focus();
            if (chatInput.shadowRoot) {
                const innerInput = chatInput.shadowRoot.querySelector('input');
                if (innerInput) innerInput.focus();
            }
        }, 150);
    }

    _isCallPayload(payload) {
        if (!payload) return false;
        if (payload.type === 'webexcall' || payload.type === 'call') return true;
        if (payload.destination && payload.accessToken) return true; // Explicit Webex Calling properties
        if (typeof payload.description === 'string' && payload.description.toLowerCase().includes('call')) return true;
        return false;
    }

    renderCallControls(callStatus) {
        const footer = this.shadowRoot.querySelector('#mainFooter');
        if (!footer) return;

        let controls = this.shadowRoot.querySelector('.call-controls');
        if (controls) return;

        controls = document.createElement('div');
        controls.className = 'call-controls';
        controls.id = 'call-controls';

        const statusKey = callStatus === 'connected' ? 'calling_status_connected' : 'calling_status_dialing';
        const statusText = callStatus ? this.i18n.t(statusKey, callStatus) : this.i18n.t('calling_status_initializing', 'Initializing...');

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

        footer.insertBefore(controls, footer.firstChild);
        footer.classList.add('has-active-call');

        controls.querySelector('#btn-hangup').addEventListener('click', () => {
            if (this.widget.callManager) this.widget.callManager.hangupCall();
        });
        controls.querySelector('#btn-mute').addEventListener('click', () => {
            if (this.widget.callManager) this.widget.callManager.toggleMute();
        });
        controls.querySelector('#btn-audio-settings').addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.widget.audioSettingsPanel) this.widget.audioSettingsPanel.toggle();
        });
    }

    updateCallStatus(status) {
        const el = this.shadowRoot.querySelector('.status-label');
        if (el) {
            el.textContent = status;
            const parent = this.shadowRoot.querySelector('.call-status');
            if (parent) parent.title = status;
        }
    }

    updateUploadProgress(percent, isVisible) {
        const progressContainer = this.shadowRoot.querySelector('#uploadProgressContainer');
        const progressBar = this.shadowRoot.querySelector('#uploadProgressBar');

        if (progressContainer && progressBar) {
            if (isVisible) {
                progressContainer.classList.add('visible');
                progressBar.style.width = `${percent}%`;
            } else {
                progressContainer.classList.remove('visible');
                progressBar.style.width = '0%';
            }
        }
    }

    startCallTimer() {
        this.callStartTime = Date.now();
        this.resumeCallTimer();
    }

    resumeCallTimer() {
        if (this.callTimerInterval) clearInterval(this.callTimerInterval);

        if (!this.callStartTime) this.callStartTime = Date.now();

        const updateUI = () => {
            const delta = Math.floor((Date.now() - this.callStartTime) / 1000);
            const min = String(Math.floor(delta / 60)).padStart(2, '0');
            const sec = String(delta % 60).padStart(2, '0');
            const el = this.shadowRoot.querySelector('.call-timer');
            if (el) el.textContent = `${min}:${sec} `;
        };

        updateUI();
        this.callTimerInterval = setInterval(updateUI, 1000);
    }

    stopCallTimer() {
        if (this.callTimerInterval) clearInterval(this.callTimerInterval);
        this.callTimerInterval = null;
    }

    addSystemMessage(text) {
        const list = this.shadowRoot.querySelector('.message-list');
        if (!list) return;

        const div = document.createElement('div');
        div.className = 'system-message';
        div.textContent = text;

        list.appendChild(div);
        setTimeout(() => list.scrollTop = list.scrollHeight, 0);
    }

    showTyping() {
        if (this.typingIndicator) return;

        const list = this.shadowRoot.querySelector('.message-list');
        if (!list) return;

        const bubble = document.createElement('div');
        bubble.className = 'message incoming typing-indicator bubble';
        bubble.innerHTML = `
              <div class="dots">
                <span>.</span><span>.</span><span>.</span>
              </div>
              `;

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

    downloadTranscript() {
        const messageList = this.shadowRoot.querySelector('.message-list');
        if (!messageList) return;

        const clone = messageList.cloneNode(true);

        const selector = 'input, textarea, select, md-input';
        const originalInputs = messageList.querySelectorAll(selector);
        const clonedInputs = clone.querySelectorAll(selector);

        originalInputs.forEach((input, i) => {
            const clonedInput = clonedInputs[i];
            if (!clonedInput) return;

            let value = '';
            let shouldConvertToPill = false;

            if (input.tagName === 'MD-INPUT') {
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

        const startLabel = clone.querySelector('.start-label');
        if (startLabel) startLabel.remove();

        const styleTag = this.shadowRoot.querySelector('style');
        const css = styleTag ? styleTag.textContent : '';

        const html = `
        <!DOCTYPE html>
          <html lang="${this.i18n.locale}">
            <head>
              <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                  <title>${this.i18n.t('chat_header')} - Transcript</title>
                  <style>
          body {
            font-family: 'Inter', sans-serif;
            margin: 0;
            padding: 20px;
            background-color: #f7f7f7;
            color: #121212;
        }
          ${css.replace(/:host/g, ':root')}
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
          .message-list {
            padding: 20px !important;
            overflow: visible !important;
            height: auto !important;
            max-width: 800px;
            margin: 0 auto;
        }
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
                    max-width: 100%;
                    word-wrap: break-word;
        }
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

        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `chat-transcript-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.html`;

        a.addEventListener('click', (e) => e.stopPropagation());

        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    setCallControlsState(state) {
        // Placeholder
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

    updateTheme(isDark) {
        const themeEl = this.shadowRoot.querySelector('md-theme');
        if (themeEl) {
            if (isDark) {
                themeEl.setAttribute('darkTheme', '');
            } else {
                themeEl.removeAttribute('darkTheme');
            }
        }
    }
}

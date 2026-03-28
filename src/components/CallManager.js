export class CallManager {
    constructor(widget) {
        this.widget = widget;
        this.activeCall = null;
        this.localStream = null;
        this.calling = null;
        this.callingClient = null;
        this.webexLine = null;
        this.currentWebexToken = null;
        this.isConnected = false;
        this._isGuestSession = false; // tracks whether the active session is a guest call
        this.callSessionId = 0; // To track active call sessions and prevent race conditions

        // BNR State
        this.bnrEffect = null;
        this.bnrEnabled = true; // Default
        try {
            const stored = localStorage.getItem('webex-cc-widget-bnr');
            if (stored !== null) {
                this.bnrEnabled = stored === 'true';
            }
        } catch (e) { /* ignore */ }

        this._boundDisconnect = this.disconnect.bind(this);
        window.addEventListener('beforeunload', this._boundDisconnect);
    }

    get i18n() {
        return this.widget.i18n;
    }

    get shadowRoot() {
        return this.widget.shadowRoot;
    }

    async startWebexCall(payload, postbackFn = null) {
        // Route guest calling (click-to-call) to its own method
        if (payload && payload.type === 'guestcall') {
            return this._startGuestCall(payload, postbackFn);
        }

        // Increment session ID to invalidate any previous pending calls
        this.callSessionId++;
        const mySessionId = this.callSessionId;

        const { destination, accessToken } = payload;
        if (!destination || !accessToken) {
            console.error('Missing destination or accessToken for Webex Call');
            return;
        }

        try {
            this.widget.renderCallControls(); // UI Setup
            this.widget.updateCallStatus(this.i18n.t('calling_status_initializing', 'Initializing SDK...'));

            // Global Singleton Strategy
            if (!this.calling && window.webexCallingInstance) {
                console.log('[Debug] Found global calling instance (singleton strategy)');
                this.calling = window.webexCallingInstance;
            }

            // Check cancellation
            if (this.callSessionId !== mySessionId) return;

            // Smart Session Management
            if (this.calling) {
                console.log('[Debug] Existing calling instance found');
                if (this.currentWebexToken && this.currentWebexToken !== accessToken) {
                    console.log('[Debug] Access Token changed. Deregistering old session...');
                    try {
                        await this.calling.deregister();
                    } catch (e) {
                        console.warn('[Debug] Deregister old session failed:', e);
                    }
                    console.log('[Debug] calling instance deregistered due to token change');
                } else {
                    console.log('[Debug] Token matches, reusing calling instance');
                }
            } else {
                console.log('[Debug] No existing calling instance');
            }
            this.currentWebexToken = accessToken;

            // Check cancellation
            if (this.callSessionId !== mySessionId) return;

            if (!this.calling) {
                // Initialization Logic
                console.log('[Debug] Checking global Webex objects');
                if (!window.WebexCore || !window.WebexCalling) {
                    console.log('[Debug] window.WebexCore or window.WebexCalling missing');
                }

                console.log('[Debug] Initializing Webex Calling SDK (Reference Pattern)...');

                const webexConfig = {
                    config: {
                        logger: { level: 'info' },
                        calling: { cacheU2C: true },
                        meetings: { reconnection: { enabled: true }, enableRtx: true },
                        encryption: { kmsInitialTimeout: 8000, kmsMaxTimeout: 40000, batcherMaxCalls: 30 }
                    },
                    credentials: {
                        access_token: accessToken
                    }
                };

                const callingConfig = {
                    clientConfig: {
                        calling: true,
                        contact: true,
                        callHistory: true,
                        callSettings: true,
                        voicemail: true
                    },
                    callingClientConfig: {
                        logger: { level: 'info' },
                        serviceData: { indicator: 'calling', domain: '' }
                    },
                    logger: { level: 'info' }
                };

                // eslint-disable-next-line no-undef
                this.calling = await Calling.init({ webexConfig, callingConfig });

                window.webexCallingInstance = this.calling;
                console.log('[Debug] Calling instance initialized and saved to window.webexCallingInstance');

                // Check cancellation
                if (this.callSessionId !== mySessionId) return;

                await new Promise((resolve) => {
                    this.calling.on('ready', () => {
                        console.log('[Debug] Calling clients ready');
                        resolve();
                    });
                });
            }

            // Check cancellation
            if (this.callSessionId !== mySessionId) return;

            // Registration
            console.log('[Debug] Checking registration status:', this.calling.registered);
            if (!this.calling.registered) {
                console.log('[Debug] Registering Calling Client...');
                await this.calling.register();
            } else {
                console.log('[Debug] Calling Client already registered');
            }

            // Check cancellation
            if (this.callSessionId !== mySessionId) return;

            this.callingClient = this.calling.callingClient;

            // Fetch Lines
            console.log('[Debug] Ensuring callingClient lines are ready...');
            await new Promise(r => setTimeout(r, 500));

            // Check cancellation
            if (this.callSessionId !== mySessionId) return;

            const lines = this.callingClient.getLines();
            console.log('[Debug] Lines retrieved:', lines);
            const line = Object.values(lines)[0];

            if (!line) {
                throw new Error('No lines found after registration');
            }

            console.log('[Debug] Line found:', line);
            if (!line.registered) {
                console.log('[Debug] Line not registered, calling register()...');
                await line.register();
                console.log('[Debug] Line registration completed.');
            } else {
                console.log('[Debug] Line already registered.');
            }

            // Check cancellation
            if (this.callSessionId !== mySessionId) return;

            this.webexLine = line;
            console.log('[Debug] Line registered status:', this.webexLine.registered);

            this.webexLine.on('line:incoming_call', (callObj) => {
                console.log('[Debug] Incoming call', callObj);
            });

            this.widget.updateCallStatus(this.i18n.t('calling_status_dialing', 'Dialing...'));

            // Media Streams
            try {
                // eslint-disable-next-line no-undef
                this.localStream = await Calling.createMicrophoneStream({ audio: true });

                // Initialize Background Noise Removal (BNR)
                if (this.localStream && typeof this.localStream.addEffect === 'function') {
                    console.log('[Debug] Initializing BNR effect...');
                    try {
                        // eslint-disable-next-line no-undef
                        const bnrEffect = await Calling.createNoiseReductionEffect({ mode: 'WORKLET' });
                        await this.localStream.addEffect(bnrEffect);
                        this.bnrEffect = bnrEffect;

                        if (this.bnrEnabled) {
                            await bnrEffect.enable();
                            console.log('[Debug] BNR enabled by default/preference');
                        } else {
                            await bnrEffect.disable();
                            console.log('[Debug] BNR disabled by preference');
                        }
                    } catch (e) {
                        console.error('[Debug] Failed to initialize BNR effect', e);
                        this.bnrEffect = null;
                    }
                }

            } catch (e) {
                console.error('[Debug] Failed to create mic stream via SDK', e);
                this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            }

            // Check cancellation
            if (this.callSessionId !== mySessionId) return;

            // Dialing
            console.log('[Debug] Dialing destination:', destination);
            const safeLine = this.webexLine || Object.values(this.callingClient.getLines())[0];

            const call = safeLine.makeCall({
                type: 'uri',
                address: destination,
                constraints: { audio: true, video: false }
            });
            this.activeCall = call;

            // Event Listeners
            const onRinging = () => {
                console.log('[Debug] Call ringing/progress');
                this.widget.updateCallStatus(this.i18n.t('calling_status_ringing', 'Ringing...'));
            };
            call.on('ringing', onRinging);
            call.on('alerting', onRinging);
            call.on('progress', onRinging);

            const onConnected = () => {
                console.log('[Debug] Call connected/established');
                this.widget._handleCallConnected(); // Call UI handler
            };
            call.on('connected', onConnected);
            call.on('connect', onConnected);
            call.on('established', onConnected);

            call.on('change:state', (newState) => {
                console.log('[Debug] Call state changed to:', newState);
                if (newState === 'connected' || newState === 'established') {
                    this.widget._handleCallConnected();
                }
            });

            call.on('change:iceConnectionState', (iceState) => {
                console.log('[Debug] ICE Connection State changed:', iceState);
                if (iceState === 'connected' || iceState === 'completed') {
                    if (this.widget.currentCallStatus !== 'connected') {
                        console.log('[Debug] Triggering connected state via ICE state');
                        this.widget._handleCallConnected();
                    }
                }
            });

            call.on('remote_media', (track) => {
                console.log('[Debug] Remote Media Received', track);
                this.handleRemoteAudio(new MediaStream([track]));
            });

            const onDisconnect = (reason) => {
                console.log('[Debug] Call disconnected:', reason);
                this.endWebexCall();
            };
            call.on('disconnected', onDisconnect);
            call.on('disconnect', onDisconnect);

            call.on('error', (err) => {
                console.error('[Debug] Call Error', err);
                this.widget.updateCallStatus(this.i18n.t('calling_status_error', 'Error'));
                setTimeout(() => this.endWebexCall(), 2000);
            });

            if (typeof call.dial === 'function') {
                call.dial(this.localStream);
            } else {
                console.warn('[Debug] Call object does not have dial method?', call);
            }

            // The SDK's internal handleOutgoingCallSetup sets callId (via call.setCallId()) from
            // the Mobius POST response body, BEFORE emitting any public events.
            // 'alerting' or 'progress' is the first public event fired after callId is populated.
            // We use a one-shot flag so the postback fires exactly once.
            let postbackSent = false;
            const onRingingWithPostback = (correlationId) => {
                if (!postbackSent && postbackFn) {
                    postbackSent = true;
                    const callId = typeof call.getCallId === 'function' ? call.getCallId() : null;
                    console.log('[Debug] First ringing event — callId from call.getCallId():', callId);
                    if (callId) {
                        postbackFn(callId);
                    } else {
                        console.warn('[Debug] callId not available yet on first ringing event');
                    }
                }
                onRinging(correlationId);
            };
            call.on('alerting', onRingingWithPostback);
            call.on('progress', onRingingWithPostback);
            // Remove duplicate plain alerting/progress listeners registered above
            call.off('alerting', onRinging);
            call.off('progress', onRinging);

        } catch (err) {
            console.error('Webex Calling Error:', err);
            this.widget.updateCallStatus(this.i18n.t('calling_status_error', 'Error') + ': ' + err.message);
            setTimeout(() => this.endWebexCall(), 3000);
        }
    }

    handleRemoteAudio(stream) {
        let audio = this.shadowRoot.querySelector('#remote-audio');
        if (!audio) {
            audio = document.createElement('audio');
            audio.id = 'remote-audio';
            audio.autoplay = true;
            audio.style.display = 'none';
            this.shadowRoot.appendChild(audio);
        }
        audio.srcObject = stream;
    }

    async hangupCall() {
        if (this.activeCall) {
            try {
                this.activeCall.end();
                console.log('Call ended successfully');
            } catch (e) {
                console.warn('End call failed:', e);
            }
        }
        // For guest sessions, _endGuestCall handles deregistration + Mercury cleanup.
        // For regular sessions, endWebexCall handles it.
        if (this._isGuestSession) {
            await this._endGuestCall();
        } else {
            await this.endWebexCall();
        }
    }

    async disconnect() {
        if (this.calling && this.calling.registered) {
            console.log('CallManager: Deregistering Webex Calling session...');
            try {
                await this.calling.deregister();
                console.log('CallManager: Deregistered successfully.');
            } catch (err) {
                console.warn('CallManager: Deregister failed', err);
            }
        }
    }

    async endWebexCall() {
        console.log('[Debug] endWebexCall invoked');
        // Invalidate any pending connection attempts
        this.callSessionId++;

        this.widget.stopCallTimer();
        if (this.activeCall) {
            console.log('[Debug] Cleaning up activeCall');
            this.activeCall = null;
        }

        // For guest sessions, _endGuestCall() handles deregistration (called via the
        // 'disconnect' event). Deregistering here too would race with _endGuestCall and
        // leave Mercury reconnecting on the old SDK instance, causing Mobius 400 errors
        // on the next call's line.register(). Only deregister for non-guest sessions.
        if (this.calling && !this._isGuestSession) {
            console.log('[Debug] Deregistering calling session after call end...');
            try {
                await this.calling.deregister();
                console.log('[Debug] Deregistered successfully');
            } catch (e) {
                console.warn('[Debug] Deregister failed:', e);
            }
            this.calling = null;
            window.webexCallingInstance = null;
        }

        this.callingClient = null;
        this.webexLine = null;

        // Remove Controls & Panel using Widget Logic
        // We could instruct widget to clean up
        // Or do it directly via shadowRoot
        const controls = this.shadowRoot.querySelector('.call-controls');
        if (controls) controls.remove();

        const panel = this.shadowRoot.querySelector('#audio-settings-panel');
        if (panel) panel.remove();

        const footer = this.shadowRoot.querySelector('#mainFooter');
        if (footer) footer.classList.remove('has-active-call');

        if (this.localStream) {
            console.log('[Debug] Stopping local stream tracks');

            // Clean up effects
            if (typeof this.localStream.disposeEffects === 'function') {
                try {
                    await this.localStream.disposeEffects();
                    console.log('[Debug] Effects disposed');
                } catch (e) {
                    console.warn('[Debug] Failed to dispose effects', e);
                }
            }

            if (typeof this.localStream.stop === 'function') {
                this.localStream.stop();
            } else if (typeof this.localStream.getTracks === 'function') {
                this.localStream.getTracks().forEach(track => track.stop());
            }
            this.localStream = null;
        }

        // Reset Widget Status
        this.widget.currentCallStatus = null;
        this.widget._isConnected = false;
    }

    toggleMute() {
        if (!this.activeCall || !this.localStream) {
            console.log('toggleMute ignored: no active call or local stream');
            return;
        }

        this.activeCall.mute(this.localStream, 'user_mute');
        let isMuted = this.localStream.userMuted;
        console.log('toggleMute called, new userMuted state:', isMuted);

        const btn = this.shadowRoot.querySelector('#btn-mute');
        const icon = btn.querySelector('md-icon');

        icon.style.color = '';

        if (isMuted) {
            icon.name = 'microphone-muted_24';
            icon.classList.remove('icon-success');
            icon.classList.add('icon-error');
        } else {
            icon.name = 'microphone-on_24';
            icon.classList.remove('icon-error');
            icon.classList.add('icon-success');
        }
        btn.style.backgroundColor = '';
    }

    async setBNR(enable) {
        console.log('[Debug] Setting BNR to:', enable);
        this.bnrEnabled = enable;
        try {
            localStorage.setItem('webex-cc-widget-bnr', enable);
        } catch (e) { /* ignore */ }

        if (this.bnrEffect) {
            try {
                if (enable) {
                    await this.bnrEffect.enable();
                    console.log('[Debug] BNR Effect Enabled');
                } else {
                    await this.bnrEffect.disable();
                    console.log('[Debug] BNR Effect Disabled');
                }
            } catch (e) {
                console.error('[Debug] Failed to toggle BNR effect', e);
            }
        } else if (this.localStream) {
            // Try to fetch if not cached (e.g. reload)
            if (typeof this.localStream.getEffectByKind !== 'function') {
                console.warn('BNR not supported on current stream');
                return;
            }
            try {
                const bnrEffect = await this.localStream.getEffectByKind('noise-reduction-effect');
                if (bnrEffect) {
                    this.bnrEffect = bnrEffect;
                    if (enable) await bnrEffect.enable();
                    else await bnrEffect.disable();
                }
            } catch (e) { /* ignore */ }
        }
    }

    // ---------------------------------------------------------------------------
    // Guest Calling (Click-to-Call)
    // ---------------------------------------------------------------------------
    async _startGuestCall(payload, postbackFn = null) {
        // Mark this as a guest session before any async work so endWebexCall() knows
        // not to deregister (that's handled by _endGuestCall via the disconnect event).
        this._isGuestSession = true;

        // Increment session ID to invalidate any previous pending calls
        this.callSessionId++;
        const mySessionId = this.callSessionId;

        const { callToken, guestToken, description } = payload;
        if (!callToken || !guestToken) {
            console.error('[GuestCall] Missing callToken or guestToken');
            return;
        }

        try {
            this.widget.renderCallControls();
            this.widget.updateCallStatus(this.i18n.t('calling_status_initializing', 'Initializing SDK...'));

            // ── PERSISTENT INSTANCE DESIGN ─────────────────────────────────────────────
            // The Webex SDK maintains a single cached webex instance. All previous attempts
            // to create a "fresh" instance by calling deregister() then re-init failed
            // because deregister() clears device.url on the shared singleton, which causes
            // the subsequent call's Mobius POST to contain cisco-device-url: undefined or
            // a stale WDM URL cached by the CallingClient from the previous session.
            //
            // SOLUTION: Treat the Calling instance as persistent for the page lifetime.
            // Between calls, only deregister the Mobius LINE (not WDM + Mercury).
            // For each new call, update credentials (access_token, jwe) then call
            // calling.register() — which re-establishes WDM + Mercury if needed while
            // keeping the CallingClient's internal state coherent.

            // Build SDK configs (needed for both first-init and credential refresh)
            const webexConfig = {
                config: {
                    logger: { level: 'info' },
                    calling: { cacheU2C: false },
                    meetings: { reconnection: { enabled: true }, enableRtx: true },
                    encryption: { kmsInitialTimeout: 8000, kmsMaxTimeout: 40000, batcherMaxCalls: 30 }
                },
                credentials: { access_token: guestToken }
            };
            const callingConfig = {
                clientConfig: {
                    calling: true, contact: false, callHistory: false,
                    callSettings: false, voicemail: false
                },
                callingClientConfig: {
                    logger: { level: 'info' },
                    serviceData: { indicator: 'guestcalling' },
                    jwe: callToken
                },
                logger: { level: 'info' }
            };

            if (this.calling) {
                // ── SUBSEQUENT CALL: reuse the persistent instance ──────────────────
                // Update access_token so all API calls use the new guest credential.
                console.log('[GuestCall] Reusing persistent Calling instance — updating credentials');
                try {
                    const webex = this.calling.webex;
                    if (webex) {
                        // Ampersand model: set() updates the attribute and triggers listeners.
                        // Fallback: direct property assignment for environments where set() is absent.
                        if (webex.credentials && typeof webex.credentials.set === 'function') {
                            webex.credentials.set({ supertoken: { access_token: guestToken, token_type: 'Bearer' } });
                        } else if (webex.credentials) {
                            try { webex.credentials.supertoken = { access_token: guestToken, token_type: 'Bearer' }; } catch (e) { /* read-only */ }
                        }
                        // Also update the raw stored token if accessible
                        try {
                            if (webex.internal?.credentials) {
                                webex.internal.credentials.supertoken = { access_token: guestToken, token_type: 'Bearer' };
                            }
                        } catch (e) { /* best-effort */ }
                        console.log('[GuestCall] Credentials updated');
                    }
                } catch (e) { console.warn('[GuestCall] Credential update failed:', e); }

                // Update the JWE callToken on the existing CallingClient so the next
                // line.register() POST carries the correct new-call authorization.
                try {
                    const cc = this.calling.callingClient;
                    if (cc) {
                        // Try known config paths
                        for (const path of [cc.config, cc.callingClientConfig, cc._config]) {
                            if (path && typeof path === 'object') {
                                try { path.jwe = callToken; } catch (e) { /* read-only */ }
                            }
                        }
                        // Also patch the line's registration module if it already exists
                        const existingLines = cc.getLines ? cc.getLines() : {};
                        for (const ln of Object.values(existingLines)) {
                            if (!ln) continue;
                            try {
                                if (ln._registration) {
                                    for (const f of ['_jwe', 'jwe', '_callToken']) {
                                        try { ln._registration[f] = callToken; } catch (e) { /* best-effort */ }
                                    }
                                }
                            } catch (e) { /* best-effort */ }
                        }
                    }
                    console.log('[GuestCall] JWE callToken updated on CallingClient');
                } catch (e) { console.warn('[GuestCall] JWE update failed:', e); }

            } else {
                // ── FIRST CALL: full initialisation ────────────────────────────────
                console.log('[GuestCall] Initializing Webex Calling SDK for guest call...');
                // eslint-disable-next-line no-undef
                this.calling = await Calling.init({ webexConfig, callingConfig });
            }

            if (!this.calling) throw new Error('[GuestCall] Calling.init() returned null');
            console.log('[GuestCall] Calling instance initialized');

            if (this.callSessionId !== mySessionId) return;

            // Wait for SDK 'ready' — only on first init (the event won't re-fire on reuse).
            if (!this.callingClient) {
                // The 'ready' event fires once after Calling.init() on a fresh instance.
                // On a reused instance it has already fired; don't wait or we'll hang.
                const alreadyReady = (() => {
                    try { return !!this.calling._state?.ready || !!this.calling.callingClient; } catch (e) { return false; }
                })();
                if (!alreadyReady) {
                    await new Promise((resolve) => {
                        this.calling.once('ready', () => {
                            console.log('[GuestCall] Calling SDK ready');
                            resolve();
                        });
                    });
                } else {
                    console.log('[GuestCall] Calling SDK already ready (reused instance)');
                }
            }

            if (this.callSessionId !== mySessionId) return;

            console.log('[GuestCall] Registering calling client...');
            await this.calling.register();

            if (this.callSessionId !== mySessionId) return;

            this.callingClient = this.calling.callingClient;

            if (this.callSessionId !== mySessionId) return;

            const lines = this.callingClient.getLines();
            console.log('[GuestCall] Lines retrieved:', lines);
            const line = Object.values(lines)[0];

            if (!line) throw new Error('[GuestCall] No lines found after registration');

            // Always (re)register the line — for a reused instance the previous call's
            // line may already be deregistered (SDK fires 'unregistered' on call end),
            // or may still be in a stale state. Force deregister first if registered.
            if (line.registered) {
                console.log('[GuestCall] Line still registered from previous call — deregistering first...');
                try { await line.deregister(); } catch (e) { /* best-effort */ }
            }
            console.log('[GuestCall] Registering line...');

            if (this.callSessionId !== mySessionId) return;

            // Wait for WDM device state to fully settle before calling line.register().
            //
            // Sequence after calling.register():
            //   1. WDM POST completes → device.url set (A)
            //   2. Mercury connects → fires device.refresh() asynchronously
            //   3. device.registering briefly set to true → WDM PUT in-flight
            //   4. WDM PUT response → device.url may change (B or stay A)
            //   5. device.registering set back to false
            //
            // If triggerRegistration() reads device.url during step 3-4, it may
            // get `undefined` → 400 Bad Request with `cisco-device-url: undefined`.
            //
            // Fix: wait for the refresh cycle (registering: false→true→false) to
            // complete. We detect the start via `change:registering`, then wait for
            // it to go back to false. A hard minimum of 400ms covers edge cases where
            // the device events aren't observable through ampersand-state.
            try {
                const dev = this.calling.webex && this.calling.webex.internal && this.calling.webex.internal.device;
                if (dev) {
                    const startMs = Date.now();
                    const MIN_WAIT = 400; // ms — covers WDM refresh latency

                    // Wait for device.url to be set initially (WDM POST done)
                    const POLL = 30;
                    let urlWait = 0;
                    while (urlWait < 5000) {
                        const url = dev.url;
                        if (url && typeof url === 'string' && url.startsWith('https://')) break;
                        await new Promise(r => setTimeout(r, POLL));
                        urlWait += POLL;
                    }

                    // Now wait for the WDM refresh cycle.
                    // Strategy: observe device.registering going true→false, which
                    // maps to the WDM PUT start→complete. If it doesn't go true within
                    // 250ms of calling.register() completing, the refresh either hasn't
                    // started yet or already finished — in either case, we apply MIN_WAIT.
                    let refreshSeen = false;
                    const refreshDone = new Promise(resolve => {
                        let truePhase = false;
                        const check = () => {
                            const r = dev.registering;
                            if (!truePhase && r) {
                                // refresh started
                                truePhase = true;
                                refreshSeen = true;
                            }
                            if (truePhase && !r) {
                                // refresh completed
                                resolve('done');
                                return;
                            }
                            setTimeout(check, 30);
                        };
                        check();
                    });
                    // Race: either refresh completes, or we time out after 3s
                    await Promise.race([
                        refreshDone,
                        new Promise(r => setTimeout(r, 3000)),
                    ]);

                    // Apply minimum wait regardless (covers race window where
                    // device.registering transitions happen faster than our tick)
                    const elapsed = Date.now() - startMs;
                    if (elapsed < MIN_WAIT) {
                        await new Promise(r => setTimeout(r, MIN_WAIT - elapsed));
                    }

                    const finalUrl = dev.url;
                    const totalMs = Date.now() - startMs;
                    console.log(`[GuestCall] device settled after ${totalMs}ms (refreshSeen=${refreshSeen}): ${finalUrl}`);
                }
            } catch (e) { /* best-effort */ }

            // ─── DIAGNOSTIC: dump entire _registration object ──────────────────────
            try {
                const dev = this.calling.webex?.internal?.device;
                const reg = line._registration;
                const devUrl = dev?.url;
                const devUserId = dev?.userId;
                console.log(`[GuestCall] PRE-register device: url=${devUrl} userId=${devUserId}`);
                if (reg) {
                    const fields = {};
                    for (const k of Object.getOwnPropertyNames(reg)) {
                        try { fields[k] = reg[k]; } catch (e) { fields[k] = '(err)'; }
                    }
                    console.log('[GuestCall] _registration fields:', JSON.stringify(fields, (k, v) => (typeof v === 'function' ? '(fn)' : v)));
                }
            } catch (e) { /* ignore */ }

            // ─── XHR INTERCEPT: Fix cisco-device-url header on Mobius /device POST ─
            // No matter which internal SDK path reads device.url, this interceptor
            // ensures the correct value reaches the network. It patches
            // XMLHttpRequest.prototype.setRequestHeader to substitute a stale/undefined
            // cisco-device-url with the current device.url, for Mobius calls only.
            // The patch is removed as soon as line.register() resolves.
            const correctDeviceUrl = (() => {
                try {
                    const d = this.calling.webex?.internal?.device;
                    const u = d?.url;
                    return (u && typeof u === 'string' && u.startsWith('https://')) ? u : null;
                } catch (e) { return null; }
            })();

            let xhrPatchActive = !!correctDeviceUrl;
            const origSetRequestHeader = xhrPatchActive && XMLHttpRequest.prototype.setRequestHeader;
            if (xhrPatchActive) {
                console.log(`[GuestCall] Installing XHR interceptor. correctDeviceUrl=${correctDeviceUrl}`);
                XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
                    if (name === 'cisco-device-url' && (!value || value === 'undefined')) {
                        console.log(`[GuestCall] XHR interceptor: replacing cisco-device-url '${value}' → '${correctDeviceUrl}'`);
                        value = correctDeviceUrl;
                    }
                    return origSetRequestHeader.call(this, name, value);
                };
            }

            try {
                await line.register();
            } finally {
                // Always remove the XHR patch
                if (xhrPatchActive && origSetRequestHeader) {
                    XMLHttpRequest.prototype.setRequestHeader = origSetRequestHeader;
                    console.log('[GuestCall] XHR interceptor removed.');
                    xhrPatchActive = false;
                }
            }

            if (this.callSessionId !== mySessionId) return;

            this.webexLine = line;
            this.widget.updateCallStatus(this.i18n.t('calling_status_dialing', 'Dialing...'));

            // Microphone stream
            try {
                // eslint-disable-next-line no-undef
                this.localStream = await Calling.createMicrophoneStream({ audio: true });

                // BNR — both WORKLET and LEGACY modes need the Webex Bearer token:
                //   WORKLET: to call Webex's signed-URL API for the worklet binary
                //   LEGACY:  to directly download the legacy processor binary from CDN
                //            (SDK throws "noise reduction: auth token is required" without it)
                // Try LEGACY first (works for guests), then WORKLET, then give up.
                if (this.localStream && typeof this.localStream.addEffect === 'function') {
                    // Extract the access token from the Calling SDK's own credentials
                    const authToken = this.calling?.webex?.credentials?.supertoken?.access_token
                        || this.calling?.webex?.credentials?.getUserToken?.()?.access_token
                        || null;
                    console.log(`[GuestCall] BNR authToken available: ${!!authToken}`);

                    const bnrModes = ['LEGACY', 'WORKLET'];
                    let bnrSuccess = false;
                    for (const mode of bnrModes) {
                        try {
                            const opts = { mode, ...(authToken ? { authToken } : {}) };
                            // eslint-disable-next-line no-undef
                            const bnrEffect = await Calling.createNoiseReductionEffect(opts);
                            await this.localStream.addEffect(bnrEffect);
                            this.bnrEffect = bnrEffect;
                            if (this.bnrEnabled) await bnrEffect.enable();
                            else await bnrEffect.disable();
                            console.log(`[GuestCall] BNR initialized with mode=${mode}`);
                            bnrSuccess = true;
                            break;
                        } catch (e) {
                            console.warn(`[GuestCall] BNR mode=${mode} failed:`, e.message || e);
                        }
                    }
                    if (!bnrSuccess) {
                        console.warn('[GuestCall] BNR unavailable for this guest session — proceeding without it');
                        this.bnrEffect = null;
                    }
                }
            } catch (e) {
                console.error('[GuestCall] SDK mic stream failed, falling back to getUserMedia', e);
                this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            }

            if (this.callSessionId !== mySessionId) return;

            // For guest calling, makeCall() takes NO arguments — destination is inside the JWE.
            console.log('[GuestCall] Placing call (no-arg makeCall)...');
            const call = line.makeCall();
            this.activeCall = call;

            // Event Listeners (identical to regular call flow)
            const onRinging = () => {
                console.log('[GuestCall] Ringing/progress');
                this.widget.updateCallStatus(this.i18n.t('calling_status_ringing', 'Ringing...'));
            };
            call.on('ringing', onRinging);
            call.on('alerting', onRinging);
            call.on('progress', onRinging);

            const onConnected = () => {
                console.log('[GuestCall] Call connected');
                this.widget._handleCallConnected();
            };
            call.on('connected', onConnected);
            call.on('connect', onConnected);
            call.on('established', onConnected);

            call.on('change:state', (newState) => {
                console.log('[GuestCall] State changed to:', newState);
                if (newState === 'connected' || newState === 'established') {
                    this.widget._handleCallConnected();
                }
            });

            call.on('change:iceConnectionState', (iceState) => {
                console.log('[GuestCall] ICE state:', iceState);
                if ((iceState === 'connected' || iceState === 'completed') &&
                    this.widget.currentCallStatus !== 'connected') {
                    this.widget._handleCallConnected();
                }
            });

            call.on('remote_media', (track) => {
                console.log('[GuestCall] Remote media received');
                this.handleRemoteAudio(new MediaStream([track]));
            });

            const onDisconnect = async (reason) => {
                console.log('[GuestCall] Call disconnected:', reason);
                await this._endGuestCall();
            };
            call.on('disconnected', onDisconnect);
            call.on('disconnect', onDisconnect);

            call.on('error', (err) => {
                console.error('[GuestCall] Call error:', err);
                this.widget.updateCallStatus(this.i18n.t('calling_status_error', 'Error'));
                setTimeout(() => this._endGuestCall(), 2000);
            });

            if (typeof call.dial === 'function') {
                call.dial(this.localStream);
            } else {
                console.warn('[GuestCall] Call object has no dial method?', call);
            }

            // The SDK's internal handleOutgoingCallSetup sets callId BEFORE emitting any public events.
            // 'alerting' or 'progress' is the first public event in which call.getCallId() is populated.
            let postbackSent = false;
            const onRingingWithPostback = (correlationId) => {
                if (!postbackSent && postbackFn) {
                    postbackSent = true;
                    const callId = typeof call.getCallId === 'function' ? call.getCallId() : null;
                    console.log('[GuestCall] First ringing event — callId from call.getCallId():', callId);
                    if (callId) {
                        postbackFn(callId);
                    } else {
                        console.warn('[GuestCall] callId not available yet on first ringing event');
                    }
                }
                onRinging(correlationId);
            };
            call.on('alerting', onRingingWithPostback);
            call.on('progress', onRingingWithPostback);
            // Remove duplicate plain alerting/progress listeners registered above
            call.off('alerting', onRinging);
            call.off('progress', onRinging);

        } catch (err) {
            console.error('[GuestCall] Error:', err);
            this.widget.updateCallStatus(this.i18n.t('calling_status_error', 'Error') + ': ' + err.message);
            setTimeout(() => this._endGuestCall(), 3000);
        }
    }

    // Cleanup for guest calls — always deregisters (one-shot session)
    async _endGuestCall() {
        console.log('[GuestCall] _endGuestCall invoked');
        // Reset guest flag immediately (before any await)
        this._isGuestSession = false;
        this.callSessionId++;

        this.widget.stopCallTimer();
        this.activeCall = null;

        // ── PERSISTENT INSTANCE DESIGN ──────────────────────────────────────────────
        // We keep this.calling alive across guest calls so the WDM device registration
        // and Mercury connection remain stable. Only the Mobius LINE registration is
        // torn down between calls (via line.deregister()). The line was already
        // deregistered when the call disconnected (the SDK fires 'unregistered'), but
        // we attempt it explicitly here as a safety net.
        if (this.webexLine) {
            const lineToClean = this.webexLine;
            this.webexLine = null;  // clear before await so re-entrant calls don't double-deregister
            try {
                // line.registered may be false if the SDK already deregistered on disconnect
                if (lineToClean.registered) {
                    console.log('[GuestCall] Deregistering Mobius line...');
                    await lineToClean.deregister();
                    console.log('[GuestCall] Mobius line deregistered');
                } else {
                    console.log('[GuestCall] Mobius line already deregistered');
                }
            } catch (e) {
                console.warn('[GuestCall] Line deregister failed (ignored):', e);
            }
        }

        // NOTE: this.calling is intentionally NOT cleared — WDM + Mercury stay connected
        //       and will be reused by the next _startGuestCall() invocation.
        //       this.callingClient is cleared so it is re-fetched fresh per call.
        this.callingClient = null;

        // Remove call controls and audio settings panel from the UI
        const controls = this.shadowRoot.querySelector('.call-controls');
        if (controls) controls.remove();
        const panel = this.shadowRoot.querySelector('#audio-settings-panel');
        if (panel) panel.remove();
        const footer = this.shadowRoot.querySelector('#mainFooter');
        if (footer) footer.classList.remove('has-active-call');

        // Stop local stream
        if (this.localStream) {
            if (typeof this.localStream.disposeEffects === 'function') {
                try { await this.localStream.disposeEffects(); } catch (e) { /* ignore */ }
            }
            if (typeof this.localStream.stop === 'function') {
                this.localStream.stop();
            } else if (typeof this.localStream.getTracks === 'function') {
                this.localStream.getTracks().forEach(t => t.stop());
            }
            this.localStream = null;
        }

        this.bnrEffect = null;
        this.widget.currentCallStatus = null;
        this.widget._isConnected = false;
    }
}

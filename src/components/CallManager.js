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

    async startWebexCall(payload) {
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
        await this.endWebexCall();
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

        console.log('[Debug] Skipping deregister to maintain stable session for next call.');

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
}

/**
 * MeetingManager — Webex Meetings SDK integration.
 *
 * Mirrors CallManager but for full meetings (audio + video + content share).
 * Triggered by a Quick Reply / card payload of type "webexmeeting":
 *   { type: "webexmeeting", destination, guestToken | accessToken, description }
 *
 * The global `Webex` object is provided by the Meetings Web SDK loaded in index.html:
 *   <script src="https://unpkg.com/webex/umd/webex.min.js"></script>
 *
 * SDK flow (transcoded / non-multistream — single composited remote video):
 *   webex = Webex.init({ config, credentials: { access_token } })
 *   await webex.meetings.register()
 *   meeting = await webex.meetings.create(destination)
 *   micStream    = await webex.meetings.mediaHelpers.createMicrophoneStream({ audio: true })
 *   cameraStream = await webex.meetings.mediaHelpers.createCameraStream({ video: true })
 *   meeting.on('media:ready' / 'media:stopped', ...)   // remoteVideo / remoteAudio / remoteShare
 *   await meeting.joinWithMedia({ joinOptions, mediaOptions })
 */
export class MeetingManager {
    constructor(widget) {
        this.widget = widget;
        this.webex = null;
        this.meeting = null;
        this.micStream = null;
        this.cameraStream = null;
        this.shareVideoStream = null;
        this.shareAudioStream = null;
        this.isSharing = false;
        this.isConnected = false;
        this._inLobby = false;
        this.meetingSessionId = 0; // guard against overlapping join attempts

        this._boundLeave = () => { this.disconnect(); };
        window.addEventListener('beforeunload', this._boundLeave);
    }

    get i18n() {
        return this.widget.i18n;
    }

    get ui() {
        return this.widget.ui;
    }

    get shadowRoot() {
        return this.widget.shadowRoot;
    }

    // ---------------------------------------------------------------------------
    // Join
    // ---------------------------------------------------------------------------
    async startMeeting(payload) {
        this.meetingSessionId++;
        const mySessionId = this.meetingSessionId;
        this._inLobby = false;
        this._mediaAdded = false;
        this._leaving = false;
        this._startedAt = null;
        this._endPosted = false;
        this.isConnected = false;

        const { destination } = payload;
        const accessToken = payload.guestToken || payload.accessToken;

        if (!destination || !accessToken) {
            console.error('[Meeting] Missing destination or access token', payload);
            this.ui.updateMeetingStatus(this.i18n.t('meeting_status_error', 'Error'));
            return;
        }

        try {
            this.ui.renderMeetingStage();
            this.ui.updateMeetingStatus(this.i18n.t('meeting_status_initializing', 'Initializing…'));

            // ── Persistent singleton (page lifetime) ─────────────────────────────
            if (!this.webex && window.webexMeetingsInstance) {
                console.log('[Meeting] Reusing global Webex meetings instance');
                this.webex = window.webexMeetingsInstance;
            }

            if (this.webex && this._currentToken && this._currentToken !== accessToken) {
                // Token changed — tear down old instance so credentials are clean.
                console.log('[Meeting] Access token changed — recreating Webex instance');
                try { await this.webex.meetings.unregister(); } catch (e) { /* ignore */ }
                this.webex = null;
                window.webexMeetingsInstance = null;
            }

            if (!this.webex) {
                // eslint-disable-next-line no-undef
                if (typeof Webex === 'undefined') {
                    throw new Error('Webex Meetings SDK not loaded (global `Webex` missing)');
                }
                console.log('[Meeting] Initializing Webex Meetings SDK…');
                // eslint-disable-next-line no-undef
                this.webex = Webex.init({
                    config: {
                        logger: { level: 'info' },
                        meetings: {
                            reconnection: { enabled: true },
                            enableRtx: true,
                            experimental: { enableUnifiedMeetings: true },
                        },
                    },
                    credentials: { access_token: accessToken },
                });
                window.webexMeetingsInstance = this.webex;

                await new Promise((resolve) => {
                    this.webex.once('ready', () => {
                        console.log('[Meeting] Webex SDK ready');
                        resolve();
                    });
                });
            }
            this._currentToken = accessToken;

            if (this.meetingSessionId !== mySessionId) return;

            // Register for meetings services (idempotent — skip if already registered)
            if (!this.webex.meetings.registered) {
                console.log('[Meeting] Registering meetings…');
                await this.webex.meetings.register();
            } else {
                console.log('[Meeting] Meetings already registered');
            }

            if (this.meetingSessionId !== mySessionId) return;

            this.ui.updateMeetingStatus(this.i18n.t('meeting_status_joining', 'Joining…'));

            // Create the meeting from the destination (SIP address, meeting number, or link)
            console.log('[Meeting] Creating meeting for destination:', destination);
            const meeting = await this.webex.meetings.create(destination);
            this.meeting = meeting;

            if (this.meetingSessionId !== mySessionId) return;

            // ── Local media ──────────────────────────────────────────────────────
            try {
                this.micStream = await this.webex.meetings.mediaHelpers.createMicrophoneStream({ audio: true });
            } catch (e) {
                console.error('[Meeting] Failed to create microphone stream', e);
            }
            try {
                this.cameraStream = await this.webex.meetings.mediaHelpers.createCameraStream({ video: true });
                const localVideo = this.shadowRoot.querySelector('.meeting-local-video');
                if (localVideo && this.cameraStream) {
                    localVideo.srcObject = this.cameraStream.outputStream;
                }
            } catch (e) {
                console.error('[Meeting] Failed to create camera stream', e);
            }

            if (this.meetingSessionId !== mySessionId) {
                this._stopLocalStreams();
                return;
            }

            // ── Remote media event wiring (must be set before join) ──────────────
            this._wireMeetingEvents(meeting);

            // ── Join WITHOUT media first ─────────────────────────────────────────
            // We intentionally do NOT use joinWithMedia(): when a guest lands in a
            // lobby (e.g. a Personal Meeting Room), Locus has not yet assigned the
            // participant a media ("confluence") node, so negotiating media in the
            // lobby fails with HTTP 409 "Confluence url for the device is null".
            // Instead we join first, then add media — immediately if we are already
            // in the meeting, or after admission (see 'meeting:self:guestAdmitted').
            console.log('[Meeting] Joining meeting…');
            await meeting.join({ enableMultistream: false });

            if (this.meetingSessionId !== mySessionId) return;

            if (this._inLobby) {
                // Media will be added once the host admits us (guestAdmitted handler).
                this.ui.updateMeetingStatus(this.i18n.t('meeting_status_lobby', 'Waiting for the host to let you in…'));
            } else {
                // Joined directly (no lobby) — add media now.
                await this._addMedia();
                this._handleMeetingConnected();
            }
        } catch (err) {
            console.error('[Meeting] Failed to join meeting:', err);
            this.ui.updateMeetingStatus(
                this.i18n.t('meeting_status_error', 'Error') + ': ' + (err.message || err)
            );
            setTimeout(() => this.leaveMeeting(), 3000);
        }
    }

    /**
     * Adds local media to the meeting. Must only be called once we are actually
     * in the meeting (not the lobby), otherwise Locus has no media node for us.
     */
    async _addMedia() {
        if (!this.meeting || this._mediaAdded) return;
        this._mediaAdded = true;
        try {
            console.log('[Meeting] Adding media…');
            await this.meeting.addMedia({
                localStreams: {
                    microphone: this.micStream || undefined,
                    camera: this.cameraStream || undefined,
                },
                audioEnabled: true,
                videoEnabled: true,
            });
            console.log('[Meeting] Media added');
        } catch (e) {
            this._mediaAdded = false;
            console.error('[Meeting] addMedia failed:', e);
            throw e;
        }
    }

    _wireMeetingEvents(meeting) {
        const remoteVideo = this.shadowRoot.querySelector('.meeting-remote-video');
        const remoteAudio = this.shadowRoot.querySelector('.meeting-remote-audio');
        const remoteShare = this.shadowRoot.querySelector('.meeting-remote-share');

        meeting.on('media:ready', (media) => {
            if (!media || !media.stream) return;
            console.log('[Meeting] media:ready —', media.type);
            switch (media.type) {
                case 'remoteVideo':
                    if (remoteVideo) remoteVideo.srcObject = media.stream;
                    break;
                case 'remoteAudio':
                    if (remoteAudio) remoteAudio.srcObject = media.stream;
                    this._handleMeetingConnected();
                    break;
                case 'remoteShare':
                    if (remoteShare) remoteShare.srcObject = media.stream;
                    break;
                default:
                    break;
            }
        });

        meeting.on('media:stopped', (media) => {
            if (!media) return;
            console.log('[Meeting] media:stopped —', media.type);
            switch (media.type) {
                case 'remoteVideo':
                    if (remoteVideo) remoteVideo.srcObject = null;
                    break;
                case 'remoteAudio':
                    if (remoteAudio) remoteAudio.srcObject = null;
                    break;
                case 'remoteShare':
                    if (remoteShare) remoteShare.srcObject = null;
                    break;
                default:
                    break;
            }
        });

        // Remote content share start/stop — toggle the share-view layout
        meeting.on('meeting:startedSharingRemote', () => {
            console.log('[Meeting] Remote share started');
            this.ui.setMeetingShareActive(true);
        });
        meeting.on('meeting:stoppedSharingRemote', () => {
            console.log('[Meeting] Remote share stopped');
            this.ui.setMeetingShareActive(false);
            // Re-attach the remote share element so a subsequent share renders (Safari fix)
            if (remoteShare) {
                const tmp = remoteShare.srcObject;
                remoteShare.srcObject = null;
                remoteShare.srcObject = tmp;
            }
        });

        // ── Lobby (guest waiting for host admission) ─────────────────────────
        meeting.on('meeting:self:lobbyWaiting', () => {
            console.log('[Meeting] Self waiting in lobby');
            this._inLobby = true;
            this.isConnected = false;
            this.ui.stopMeetingTimer();
            this.ui.setMeetingControlsState('lobby');
            this.ui.updateMeetingStatus(
                this.i18n.t('meeting_status_lobby', 'Waiting for the host to let you in…')
            );
        });
        meeting.on('meeting:self:guestAdmitted', async () => {
            console.log('[Meeting] Guest admitted from lobby');
            this._inLobby = false;
            this.ui.updateMeetingStatus(this.i18n.t('meeting_status_connecting', 'Connecting…'));
            try {
                // Now that we're admitted, Locus has assigned a media node — add media.
                await this._addMedia();
                this._handleMeetingConnected();
            } catch (e) {
                console.error('[Meeting] Failed to add media after admission:', e);
                this.ui.updateMeetingStatus(this.i18n.t('meeting_status_error', 'Error'));
                setTimeout(() => this.leaveMeeting(), 3000);
            }
        });

        // Meeting ended / self left remotely
        // Meeting ended / self left remotely
        meeting.on('meeting:self:left', () => {
            console.log('[Meeting] Self left');
            this.leaveMeeting();
        });
        meeting.on('meeting:ended', () => {
            console.log('[Meeting] Meeting ended');
            this.leaveMeeting();
        });
        meeting.on('error', (err) => {
            console.error('[Meeting] Meeting error:', err);
        });

        // Robust catch-all for the meeting ending/being removed (e.g. host ends it
        // for everyone). The per-meeting events above don't always fire in that case,
        // so we also listen on the meetings collection and match by id.
        this._onMeetingRemoved = (payload) => {
            if (!payload || payload.meetingId === meeting.id) {
                console.log('[Meeting] meeting:removed', payload && payload.reason);
                this.leaveMeeting();
            }
        };
        this.webex.meetings.on('meeting:removed', this._onMeetingRemoved);
    }

    /** Formats a Date as a short local time string, e.g. "14:07". */
    _formatTime(date) {
        try {
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch (e) {
            return date.toISOString().substr(11, 5);
        }
    }

    _handleMeetingConnected() {
        if (this.isConnected) return;
        if (this._inLobby) return; // still waiting for admission
        this.isConnected = true;
        this._startedAt = new Date();
        this.ui.updateMeetingStatus(this.i18n.t('meeting_status_connected', 'Connected'));
        this.ui.setMeetingControlsState('connected');
        this.ui.startMeetingTimer();
        // Post a service message into the chat transcript.
        this.ui.addSystemMessage(
            `${this.i18n.t('meeting_started_at', 'Meeting started at')} ${this._formatTime(this._startedAt)}`
        );
    }

    // ---------------------------------------------------------------------------
    // Controls
    // ---------------------------------------------------------------------------
    toggleMute() {
        if (!this.micStream) return false;
        const newMuted = !this.micStream.userMuted;
        this.micStream.setUserMuted(newMuted);
        console.log('[Meeting] Audio muted:', newMuted);
        return newMuted;
    }

    toggleVideo() {
        if (!this.cameraStream) return false;
        const newMuted = !this.cameraStream.userMuted;
        this.cameraStream.setUserMuted(newMuted);
        console.log('[Meeting] Video muted:', newMuted);
        return newMuted;
    }

    async toggleShare() {
        if (this.isSharing) {
            await this._stopShare();
            return false;
        }
        await this._startShare();
        return this.isSharing;
    }

    async _startShare() {
        if (!this.meeting) return;
        try {
            let shareVideo, shareAudio;
            const helpers = this.webex.meetings.mediaHelpers;
            if (typeof helpers.createDisplayStreamWithAudio === 'function') {
                [shareVideo, shareAudio] = await helpers.createDisplayStreamWithAudio();
            } else {
                shareVideo = await helpers.createDisplayStream();
            }
            this.shareVideoStream = shareVideo;
            this.shareAudioStream = shareAudio || null;

            // When the user stops sharing via the browser's native control
            shareVideo.on('stream-ended', () => {
                console.log('[Meeting] Local share stream ended');
                this._stopShare();
            });

            await this.meeting.publishStreams({
                screenShare: {
                    video: this.shareVideoStream,
                    audio: this.shareAudioStream || undefined,
                },
            });
            this.isSharing = true;
            this.ui.setMeetingSharingState(true);
            console.log('[Meeting] Screen share published');
        } catch (e) {
            console.error('[Meeting] Failed to start screen share', e);
            this.isSharing = false;
            this.ui.setMeetingSharingState(false);
        }
    }

    async _stopShare() {
        if (!this.meeting) return;
        try {
            const toUnpublish = [];
            if (this.shareAudioStream) toUnpublish.push(this.shareAudioStream);
            if (this.shareVideoStream) toUnpublish.push(this.shareVideoStream);
            if (toUnpublish.length) {
                await this.meeting.unpublishStreams(toUnpublish);
            }
        } catch (e) {
            console.warn('[Meeting] unpublishStreams failed', e);
        }
        try { this.shareVideoStream && this.shareVideoStream.stop(); } catch (e) { /* ignore */ }
        try { this.shareAudioStream && this.shareAudioStream.stop(); } catch (e) { /* ignore */ }
        this.shareVideoStream = null;
        this.shareAudioStream = null;
        this.isSharing = false;
        this.ui.setMeetingSharingState(false);
        console.log('[Meeting] Screen share stopped');
    }

    // ---------------------------------------------------------------------------
    // Leave / cleanup
    // ---------------------------------------------------------------------------
    async leaveMeeting() {
        // Guard against re-entrancy — leaveMeeting() can be triggered by several
        // events at once (self:left, meeting:removed, user click, media failure).
        if (this._leaving) return;
        this._leaving = true;

        console.log('[Meeting] leaveMeeting invoked');
        this.meetingSessionId++; // invalidate any pending join
        this.isConnected = false;
        this._inLobby = false;
        this._mediaAdded = false;

        this.ui.stopMeetingTimer();

        // Detach the meetings-collection listener so it doesn't fire for future meetings.
        if (this.webex && this.webex.meetings && this._onMeetingRemoved) {
            try { this.webex.meetings.off('meeting:removed', this._onMeetingRemoved); } catch (e) { /* ignore */ }
            this._onMeetingRemoved = null;
        }

        // Post an "ended" service message into the chat transcript — but only if the
        // meeting actually started (was connected), and only once.
        if (this._startedAt && !this._endPosted) {
            this._endPosted = true;
            this.ui.addSystemMessage(
                `${this.i18n.t('meeting_ended_at', 'Meeting ended at')} ${this._formatTime(new Date())}`
            );
        }

        if (this.isSharing) {
            await this._stopShare();
        }

        if (this.meeting) {
            try {
                await this.meeting.leave();
                console.log('[Meeting] Left meeting');
            } catch (e) {
                console.warn('[Meeting] leave() failed', e);
            }
            this.meeting = null;
        }

        this._stopLocalStreams();
        this.ui.removeMeetingStage();
        this._leaving = false;
    }

    _stopLocalStreams() {
        [this.micStream, this.cameraStream].forEach((s) => {
            if (!s) return;
            try {
                if (typeof s.stop === 'function') s.stop();
            } catch (e) { /* ignore */ }
        });
        this.micStream = null;
        this.cameraStream = null;
    }

    /** Called on page unload — unregister the persistent instance. */
    async disconnect() {
        try {
            if (this.meeting) {
                await this.meeting.leave();
            }
        } catch (e) { /* ignore */ }
        this._stopLocalStreams();
        if (this.webex && this.webex.meetings && this.webex.meetings.registered) {
            try { await this.webex.meetings.unregister(); } catch (e) { /* ignore */ }
        }
    }
}

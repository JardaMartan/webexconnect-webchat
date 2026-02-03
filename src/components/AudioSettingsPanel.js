export class AudioSettingsPanel {
    constructor(widget) {
        this.widget = widget;
    }

    get shadowRoot() {
        return this.widget.shadowRoot;
    }

    get i18n() {
        return this.widget.i18n;
    }

    async toggle() {
        let panel = this.shadowRoot.querySelector('#audio-settings-panel');

        // HTML Generation if not exists
        if (!panel) {
            this.render();
            panel = this.shadowRoot.querySelector('#audio-settings-panel');
        }

        if (!panel) return;

        const isVisible = panel.classList.contains('visible');

        if (isVisible) {
            panel.classList.remove('visible');
            panel.style.display = 'none';
            // Remove clicked outside listener if it was added specifically for this open session
        } else {
            panel.classList.add('visible');
            panel.style.display = 'flex';
            await this.populateDevices();
        }
    }

    render() {
        const parent = this.shadowRoot.querySelector('#mainFooter');
        // Logic from ChatWidget.js used insertBefore footer.firstChild inside renderCallControls?
        // Actually, in ChatWidget.js it was appended to shadowRoot directly in the original code I read (line 2257), 
        // BUT the styles refactoring might have changed it. 
        // Let's stick to appending to shadowRoot or a specific container.
        // In the snippets, it was `this.shadowRoot.appendChild(panel);` (Line 2257).

        // Wait, recent styles put it absolute bottom 150px.

        const panel = document.createElement('div');
        panel.id = 'audio-settings-panel';
        panel.className = 'settings-panel';

        // Note: Styles are now in chat-widget.css, so we don't need to inject <style> block anymore.

        panel.innerHTML = `
        <div class="panel-header">
           <span class="panel-title">${this.i18n.t('audio_settings_title', 'Audio Settings')}</span>
           <button class="close-btn" id="btn-close-settings" title="${this.i18n.t('close', 'Close')}">
             <md-icon name="cancel_16" size="16"></md-icon>
           </button>
        </div>
        <div class="setting-group">
          <label for="mic-select">${this.i18n.t('audio_settings_mic_label', 'Microphone')}</label>
          <select id="mic-select"><option>${this.i18n.t('loading', 'Loading...')}</option></select>
        </div>
        <div class="setting-group">
          <label for="speaker-select">${this.i18n.t('audio_settings_speaker_label', 'Speaker')}</label>
          <select id="speaker-select"><option>${this.i18n.t('loading', 'Loading...')}</option></select>
        </div>
      `;

        this.shadowRoot.appendChild(panel);

        // Event Binding
        panel.querySelector('#btn-close-settings').addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle();
        });

        panel.querySelector('#mic-select').addEventListener('change', (e) => this.switchMicrophone(e.target.value));
        panel.querySelector('#speaker-select').addEventListener('change', (e) => this.switchSpeaker(e.target.value));

        // Click outside logic is handled by ChatWidget._handleClickOutside usually, 
        // but if we want it self-contained, we might need a public method `close()` used by the widget.
    }

    close() {
        const panel = this.shadowRoot.querySelector('#audio-settings-panel');
        if (panel && panel.classList.contains('visible')) {
            panel.classList.remove('visible');
            panel.style.display = 'none';
        }
    }

    async populateDevices() {
        try {
            // Ensure we have permission labels
            await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop())).catch(() => { });

            const devices = await navigator.mediaDevices.enumerateDevices();
            const micSelect = this.shadowRoot.querySelector('#mic-select');
            const speakerSelect = this.shadowRoot.querySelector('#speaker-select');

            // Save current selection (or default)
            const currentMic = this.selectedMicId || '';
            const currentSpeaker = this.selectedSpeakerId || '';

            micSelect.innerHTML = '';
            speakerSelect.innerHTML = '';

            devices.forEach(device => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.text = device.label || `${device.kind} - ${device.deviceId.slice(0, 5)}...`;

                if (device.kind === 'audioinput') {
                    micSelect.appendChild(option);
                    if (device.deviceId === currentMic) option.selected = true;
                } else if (device.kind === 'audiooutput') {
                    speakerSelect.appendChild(option);
                    if (device.deviceId === currentSpeaker) option.selected = true;
                }
            });

            // Handle empty lists
            if (micSelect.options.length === 0) micSelect.innerHTML = `<option>${this.i18n.t('no_microphones_found', 'No Microphones found')}</option>`;
            if (speakerSelect.options.length === 0) speakerSelect.innerHTML = `<option>${this.i18n.t('no_speakers_found', 'No Speakers found')}</option>`;

        } catch (e) {
            console.error('[Debug] Error populating devices:', e);
        }
    }

    async switchMicrophone(deviceId) {
        console.log('[Debug] Switching Microphone to:', deviceId);
        this.selectedMicId = deviceId;
        try {
            const newStream = await navigator.mediaDevices.getUserMedia({
                audio: { deviceId: { exact: deviceId } }
            });

            // Replace in active call
            if (this.widget.callManager && this.widget.callManager.activeCall) {
                const audioTrack = newStream.getAudioTracks()[0];
                // Search for senders
                if (this.widget.callManager.activeCall.peerConnection) {
                    const sender = this.widget.callManager.activeCall.peerConnection.getSenders().find(s => s.track && s.track.kind === 'audio');
                    if (sender) {
                        await sender.replaceTrack(audioTrack);
                        console.log('[Debug] Audio track replaced successfully');
                    } else {
                        console.warn('[Debug] No audio sender found to replace');
                    }
                }
                // Update local stream reference in callManager
                this.widget.callManager.localStream = newStream;
            }
        } catch (e) {
            console.error('[Debug] Failed to switch microphone:', e);
        }
    }

    async switchSpeaker(deviceId) {
        console.log('[Debug] Switching Speaker to:', deviceId);
        this.selectedSpeakerId = deviceId;
        const audioEl = this.shadowRoot.querySelector('#remote-audio');
        if (audioEl) {
            if (typeof audioEl.setSinkId === 'function') {
                try {
                    await audioEl.setSinkId(deviceId);
                    console.log('[Debug] Speaker switched successfully');
                } catch (e) {
                    console.error('[Debug] Failed to set sink ID:', e);
                }
            } else {
                console.warn('[Debug] Browser does not support setSinkId (output device selection)');
            }
        }
    }
}

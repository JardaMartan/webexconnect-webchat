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

            const bnrSwitch = panel.querySelector('#bnr-switch');
            if (bnrSwitch) {
                bnrSwitch.checked = this.widget.callManager.bnrEnabled;
            }

            await this.populateDevices();
            this.applyComponentStyles();
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
           <md-button variant="secondary" circle size="28" id="btn-close-settings" title="${this.i18n.t('close', 'Close')}">
             <md-icon name="cancel_16" size="16"></md-icon>
           </md-button>
        </div>
        <div class="setting-group">
          <label for="mic-select">${this.i18n.t('audio_settings_mic_label', 'Microphone')}</label>
          <md-dropdown id="mic-dropdown" placeholder="${this.i18n.t('loading', 'Loading...')}" style="width: 100%;"></md-dropdown>
        </div>
        <div class="setting-group">
          <label for="speaker-select">${this.i18n.t('audio_settings_speaker_label', 'Speaker')}</label>
          <md-dropdown id="speaker-dropdown" placeholder="${this.i18n.t('loading', 'Loading...')}" style="width: 100%;"></md-dropdown>
        </div>
        <div class="setting-group checkbox-group">
            <!-- md-toggle-switch displays label internally if passed, usually to the right. 
                 If 'label' attribute doesn't work, we might need a slot or external label.
                 Based on d.ts, it has a 'label' property. Let's try explicit property binding if attr fails, 
                 but visual clutter might be the issue. 
                 Let's try putting the text inside the tag as a slot if it supports it, 
                 OR keeps the external label and remove the 'label' attr to avoid duplication if it was working poorly.
                 Actually user said "no label", implying the attribute didn't render anything.
                 Let's keep external label style for consistency if the component is tricky.
                 BUT 'all white' implies styling issue.
                 Let's try standard approach: -->
            <md-toggle-switch id="bnr-switch" style="width: 100%;" small><span style="font-size: 12px;">${this.i18n.t('audio_settings_bnr_label', 'Remove Background Noise')}</span></md-toggle-switch>
        </div>
      `;

        this.shadowRoot.appendChild(panel);

        // Event Binding
        panel.querySelector('#btn-close-settings').addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle();
        });

        panel.querySelector('#mic-dropdown').addEventListener('dropdown-selected', (e) => {
            const selected = e.detail.option;
            if (selected && selected.id) this.switchMicrophone(selected.id);
        });

        panel.querySelector('#speaker-dropdown').addEventListener('dropdown-selected', (e) => {
            const selected = e.detail.option;
            if (selected && selected.id) this.switchSpeaker(selected.id);
        });

        const bnrSwitch = panel.querySelector('#bnr-switch');
        if (bnrSwitch) {
            bnrSwitch.checked = this.widget.callManager.bnrEnabled;
            // md-toggle-switch usually emits 'nav-toggle-switch' or just standard 'change/click'?
            // d.ts doesn't specify event, but typically custom elements dispatch 'change' or similar. 
            // Let's stick with 'click' or 'change' and check property.
            // Actually, usually it's just a click handler on the element or internal event. 
            // Let's assume 'change' works or falls back to click.
            bnrSwitch.addEventListener('click', (e) => {
                // Determine new state (it might toggle automatically visually, we need to read state)
                setTimeout(() => {
                    this.widget.callManager.setBNR(bnrSwitch.checked);
                }, 0);
            });
        }

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
            // ... (rest of logic) ... but I need to call applyStyles at the end 

            // Call populate logic 
            // Reuse existing logic but I need to modify the END of it.
            // Since replace_file_content replaces a block, I will let the existing logic remain and just append the call?
            // "Instruction: Inject styles into component Shadow DOMs".
            // I'll rewrite the method start to include the helper, or likely add the helper method to the class and call it.

            // ACTUALLY: I should replace the END of populateDevices or the whole method. 
            // Providing the whole method is safer to ensure I don't break existing logic.
        } catch (e) { }
    }

    // Better strategy: Add the new method `applyComponentStyles` and call it from `toggle` and `populateDevices`.
    // I will insert `applyComponentStyles` before `populateDevices` and update `toggle` to call it.

    applyComponentStyles() {
        setTimeout(() => {
            const dropdowns = this.shadowRoot.querySelectorAll('md-dropdown');
            const toggle = this.shadowRoot.querySelector('md-toggle-switch');

            /* Dropdown CSS Injection - Mimicking Momentum UI with enforced visibility */
            dropdowns.forEach(dd => {
                if (dd.shadowRoot && !dd.shadowRoot.querySelector('#injected-styles')) {
                    const style = document.createElement('style');
                    style.id = 'injected-styles';
                    style.textContent = `
                        /* Trigger Button (Label) */
                        .md-dropdown-label {
                            border: 1px solid #b2b2b2 !important;
                            border-radius: 4px !important;
                            padding: 6px 12px 6px 8px !important;
                            background: #ffffff !important;
                            min-height: 32px !important;
                            display: flex !important;
                            justify-content: space-between !important;
                            align-items: center !important;
                            cursor: pointer !important;
                            color: #121212 !important;
                            font-family: inherit !important;
                            font-size: 12px !important;
                            box-sizing: border-box !important;
                        }

                        .md-dropdown-label:hover {
                            border-color: #0070d2 !important;
                        }

                        /* Ensure Text is visible */
                        .md-dropdown-label--text {
                            color: inherit !important;
                            flex: 1 !important;
                            white-space: nowrap !important;
                            overflow: hidden !important;
                            text-overflow: ellipsis !important;
                            margin-right: 8px !important;
                        }

                        /* Force Icon Visibility */
                        md-icon {
                            color: #555555 !important;
                            display: flex !important;
                            align-items: center !important;
                        }

                        .md-dropdown-label--icon {
                            display: flex !important;
                            align-items: center !important;
                        }

                        /* Dropdown List Container */
                        .md-dropdown-list {
                            background-color: #ffffff !important;
                            border: 1px solid #e5e5e5 !important;
                            border-radius: 4px !important;
                            box-shadow: 0 4px 12px rgba(0,0,0,0.15) !important;
                            margin-top: 4px !important;
                            padding: 4px 0 !important;
                            z-index: 1000 !important;
                        }

                        /* Options */
                        .md-dropdown-option {
                            padding: 8px 12px !important;
                            color: #121212 !important;
                            cursor: pointer !important;
                            font-size: 12px !important;
                            background-color: transparent !important;
                            display: flex !important;
                            align-items: center !important;
                        }

                        .md-dropdown-option:hover {
                            background-color: #f5f5f5 !important;
                        }

                        /* Selected Option */
                        .md-dropdown-option[selected] {
                            background-color: #e6f0ff !important;
                            color: #0070d2 !important;
                            position: relative !important;
                        }
                        
                        /* Blue bar indicator for selected */
                        .md-dropdown-option[selected]::before {
                            content: "" !important;
                            position: absolute !important;
                            left: 0 !important;
                            top: 0 !important;
                            bottom: 0 !important;
                            width: 3px !important;
                            background-color: #0070d2 !important;
                        }
                    `;
                    dd.shadowRoot.appendChild(style);
                }
            });

            if (toggle) {
                if (!toggle.hasAttribute('small')) {
                    toggle.setAttribute('small', '');
                }

                if (toggle.shadowRoot && !toggle.shadowRoot.querySelector('#injected-styles')) {
                    const style = document.createElement('style');
                    style.id = 'injected-styles';
                    style.textContent = `
                        /* Reset container background explicitly */
                        .md-toggle-switch {
                            background-color: transparent !important;
                            border: none !important;
                            font-family: inherit !important;
                        }
                        
                        /* Track Styles - Rely on 'small' sizing but force colors */
                        .md-toggle-switch__label__container {
                            background-color: #bcd2d9 !important; /* Greyish off state */
                            border: 1px solid #7f7f7f !important;
                            opacity: 1 !important;
                            /* We do NOT force width/height here to avoid breaking 'small' layout */
                        }

                        /* Handle Styles */
                        .md-toggle-switch__label__container::after {
                            background-color: #ffffff !important;
                            border: 1px solid #7f7f7f !important;
                            /* We do NOT force dimensions/position here to avoid misalignment */
                        }
                        
                        /* CHECKED STATE */
                        .md-toggle-switch__input:checked + .md-toggle-switch__label .md-toggle-switch__label__container {
                            background-color: #0070d2 !important; /* Blue on state */
                            border-color: #0070d2 !important;
                        }
                        
                        .md-toggle-switch__input:checked + .md-toggle-switch__label .md-toggle-switch__label__container::after {
                            border-color: #0070d2 !important;
                        }
                        
                        /* Text Label Visibility - Re-added ::slotted(*) */
                        .md-toggle-switch__label, 
                        .md-label,
                        label,
                        ::slotted(*) {
                            color: #121212 !important;
                            font-size: 12px !important;
                            line-height: inherit !important;
                            font-weight: normal !important; /* Ensure it's not inheriting bold from headers if that's the issue */
                        }
                    `;
                    toggle.shadowRoot.appendChild(style);
                }
            }
        }, 100); // Small delay to ensure shadow DOM is ready
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

            const micOptions = [];
            const speakerOptions = [];

            devices.forEach(device => {
                const label = device.label || `${device.kind} - ${device.deviceId.slice(0, 5)}...`;
                // md-dropdown options format: [string | { key: string, value: string }]
                // We use objects to store deviceId as value (key) and label as display text (value) ... wait.
                // Dropdown.d.ts: OptionMember = { [key: string]: string }
                // RenderOptionMember = { key: string, value: string, option?: Option }
                // Looking at standard usage: options = ["A", "B"] OR objects.
                // Best practice for Momentum UI Dropdown: Use simple strings if possible, OR key/value pairs.
                // Let's use simple key/value objects: { "mic-id": "Mic Label" } style? No, array of objects usually.
                // Let's try standard structure: { key: deviceId, value: label } ? No looking at d.ts: OptionMember is flexible key-value.
                // Actually usage is often just array of strings. But we need IDs.
                // Let's try [{ [deviceId]: label }] as OptionMember or verify stories.
                // Simpler: Just store the whole object if we can, but let's stick to key/value pairs if supported.
                // Actually, let's use the `option-id` and `option-value` props if available, OR just pass array of strings and map back index? No.
                // Proper way: Options array where each item is { [key]: value }. But key needs to be unique for selection.

                // Let's try: options = [{id: 'devId', value: 'Label'}] and set option-id='id' option-value='value'.
                // Checking Dropdown.d.ts: optionId: string, optionValue: string. YES.

                const opt = { id: device.deviceId, value: label };

                if (device.kind === 'audioinput') {
                    micOptions.push(opt);
                } else if (device.kind === 'audiooutput') {
                    speakerOptions.push(opt);
                }
            });

            const micDropdown = this.shadowRoot.querySelector('#mic-dropdown');
            const speakerDropdown = this.shadowRoot.querySelector('#speaker-dropdown');

            if (micDropdown) {
                micDropdown.optionId = 'id';
                micDropdown.optionValue = 'value';
                micDropdown.options = micOptions.length ? micOptions : [{ id: '', value: this.i18n.t('no_microphones_found', 'No Microphones found') }];

                // Set initial selection
                if (currentMic) {
                    // We need to match the option object or string? 
                    // Momentum Dropdown usually takes the option object as defaultOption OR just relies on internal matching if we set it?
                    // Let's try finding the option object.
                    const selected = micOptions.find(o => o.id === currentMic);
                    if (selected) micDropdown.defaultOption = selected;
                } else if (micOptions.length > 0) {
                    micDropdown.defaultOption = micOptions[0];
                }
            }

            if (speakerDropdown) {
                speakerDropdown.optionId = 'id';
                speakerDropdown.optionValue = 'value';
                speakerDropdown.options = speakerOptions.length ? speakerOptions : [{ id: '', value: this.i18n.t('no_speakers_found', 'No Speakers found') }];

                if (currentSpeaker) {
                    const selected = speakerOptions.find(o => o.id === currentSpeaker);
                    if (selected) speakerDropdown.defaultOption = selected;
                } else if (speakerOptions.length > 0) {
                    speakerDropdown.defaultOption = speakerOptions[0];
                }
            }

        } catch (e) {
            console.error('[Debug] Error populating devices:', e);
        }
        this.applyComponentStyles();
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

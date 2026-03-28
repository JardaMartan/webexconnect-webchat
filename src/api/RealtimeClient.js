
import mqtt from 'mqtt';
import { decryptMessage, maybeDecrypt } from './MessageCrypto.js';
import { WebexClient } from './WebexClient.js';

const MQTT_CONFIG = {
    host: 'CCBootcampSandboxccbcamp1023wbxai.msg-usor.us.webexconnect.io',
    port: 443,
    protocol: 'wss',
    path: '/mqtt',
    clientId: `web_client_${Date.now()}`
};

export class RealtimeClient {
    constructor() {
        this.client = null;
        this.callbacks = [];
        this._disconnectCallbacks = [];
    }

    connect(creds) {
        return new Promise((resolve, reject) => {
            const host = creds.host;
            if (!host) {
                console.error('MQTT Host not configured!');
                throw new Error('Missing MQTT Host config');
            }

            const url = `wss://${host}:443/mqtt`;
            console.log('Connecting to MQTT', url);
            console.log('MQTT Creds:', { ...creds, password: '***' });

            this.client = mqtt.connect(url, {
                reconnectPeriod: 1000,
                clientId: creds.clientId,
                username: creds.username,
                password: creds.password,
                protocolId: 'MQTT',
                protocolVersion: 4
            });

            this.client.on('connect', () => {
                console.log('MQTT Connected');
                resolve();
            });

            this.client.on('error', (err) => {
                console.error('MQTT connection error', err);
            });

            // Fire disconnect callbacks when connection is lost
            this.client.on('close', () => {
                console.log('[RealtimeClient] MQTT connection closed');
                this._disconnectCallbacks.forEach(cb => cb());
            });

            this.client.on('offline', () => {
                console.log('[RealtimeClient] MQTT client offline');
                this._disconnectCallbacks.forEach(cb => cb());
            });

            this.client.on('message', async (topic, message) => {
                const rawStr = message.toString();
                try {
                    let payloadStr = rawStr;
                    if (WebexClient.isEncryptionEnabled()) {
                        try {
                            payloadStr = await decryptMessage(rawStr);
                            console.log('[RealtimeClient] Decrypted incoming MQTT message.');
                        } catch (decryptErr) {
                            console.warn('[RealtimeClient] Decrypt failed, trying as plaintext:', decryptErr.message);
                        }
                    }
                    const parsed = JSON.parse(payloadStr);
                    this.callbacks.forEach(cb => cb(parsed));
                } catch (e) {
                    console.error('[RealtimeClient] Error parsing/decrypting MQTT message', e, rawStr.substring(0, 60));
                }
            });
        });
    }

    subscribeToUserTopic(appId, userId) {
        const topic = `${appId}/${userId}`;
        console.log('Subscribing to topic:', topic);
        this.client.subscribe(topic, { qos: 1 }, (err) => {
            if (err) console.error('Subscription failed', err);
            else console.log('Subscribed successfully to', topic);
        });
    }

    onMessage(callback) {
        this.callbacks.push(callback);
    }

    /** Register a callback for when the MQTT connection is lost. */
    onDisconnect(callback) {
        this._disconnectCallbacks.push(callback);
    }

    disconnect() {
        if (this.client) {
            console.log('Disconnecting MQTT');
            this.client.end();
            this.client = null;
        }
    }
}

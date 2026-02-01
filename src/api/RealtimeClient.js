
import mqtt from 'mqtt';

const MQTT_CONFIG = {
    host: 'CCBootcampSandboxccbcamp1023wbxai.msg-usor.us.webexconnect.io',
    port: 443,
    protocol: 'wss',
    path: '/mqtt', // Standard path, might need adjustment if HAR showed different
    clientId: `web_client_${Date.now()}` // Dynamic client ID for MQTT
};

export class RealtimeClient {
    constructor() {
        this.client = null;
        this.callbacks = [];
    }

    connect(creds) {
        return new Promise((resolve, reject) => {
            // Use dynamic host/port from credentials (provided by Register response)
            const host = creds.host;
            if (!host) {
                console.error('MQTT Host not configured!');
                throw new Error('Missing MQTT Host config');
            }

            // Note: Protocol might need to be secure (wss)
            const url = `wss://${host}:443/mqtt`;
            console.log('Connecting to MQTT', url);

            // Mask password in logs
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
                // Don't reject, let it retry, but valid failure handling might use a timeout race.
                // For now, resolving on connect is primary goal. 
            });

            this.client.on('message', (topic, message) => {
                console.log('Received message:', topic, message.toString());
                try {
                    const parsed = JSON.parse(message.toString());
                    this.callbacks.forEach(cb => cb(parsed));
                } catch (e) {
                    console.error('Error parsing MQTT message', e);
                }
            });
        });
    }

    // Topic structure needs to be guessed or found in HAR. 
    // Often it's `apps/{appId}/users/{userId}/...`
    // I'll use a wildcard or the userId based topic found in typical Webex deployments.
    // HAR might reveal subscription. 
    // If not, I'll try `apps/AI02083657/users/06ac4702-e37b-4054-a505-b93d432d9a18/#`
    subscribeToUserTopic(appId, userId) {
        // Topic format: {appId}/{userId}
        // Corrected Analysis: Reference trace len=47 means NO leading slash.
        // Matching the username format found in reference trace
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

    disconnect() {
        if (this.client) {
            console.log('Disconnecting MQTT');
            this.client.end();
            this.client = null;
        }
    }
}

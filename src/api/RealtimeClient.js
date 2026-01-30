
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
        // Use dynamic host/port from credentials (provided by Register response)
        const host = creds.host || 'CCBootcampSandboxccbcamp1023wbxai.msg-usor.us.webexconnect.io'; // Fallback
        const port = creds.port || 443;
        const protocol = 'wss';
        const path = '/mqtt';

        const url = `${protocol}://${host}:${port}${path}`;
        console.log('Connecting to MQTT', url);
        console.log('MQTT Creds:', { ...creds, password: '***' });

        this.client = mqtt.connect(url, {
            reconnectPeriod: 1000,
            clientId: creds.clientId,
            username: creds.username,
            password: creds.password, // This is the secretKey (WN2Ghmg0)
            protocolId: 'MQTT',
            protocolVersion: 4
        });

        this.client.on('connect', () => {
            console.log('MQTT Connected');
            // Subscription should be called manually with correct params
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

        this.client.on('error', (err) => {
            console.error('MQTT Error', err);
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

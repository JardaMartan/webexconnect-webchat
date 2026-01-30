
import { SignJWT } from 'jose';

// Helper to generate random string
const generateRandomString = (length) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

const CONFIG = {
  baseUrl: '',
  appId: '',
  userId: '',
  clientId: '',
  clientKey: '', // "secretkey" header
  accessToken: '', // Optional: Opaque token from config
  deviceId: ''
};

export const WebexClient = {
  initialize: async (config) => {
    Object.assign(CONFIG, config);

    // Generate or retrieve User ID if not provided
    // Generate or retrieve User ID if not provided
    if (!CONFIG.userId) {
      // FIX: Check localStorage first!
      let storedUserId = localStorage.getItem('webex_user_id');
      if (!storedUserId) {
        storedUserId = crypto.randomUUID();
        localStorage.setItem('webex_user_id', storedUserId);
      }
      CONFIG.userId = storedUserId;
    }

    // Generate Client ID
    // Format: appId/userId/deviceId
    let deviceId = localStorage.getItem('webex_device_id');
    if (!deviceId) {
      deviceId = 'v2_web_' + Math.random().toString(36).substring(2, 15);
      localStorage.setItem('webex_device_id', deviceId);
    }
    CONFIG.deviceId = deviceId;
    CONFIG.clientId = `${CONFIG.appId}/${CONFIG.userId}/${CONFIG.deviceId}`;

    console.log('WebexClient Initialized. UserID:', CONFIG.userId);

    // Perform Registration to get Access Token
    try {
      await WebexClient.register();
    } catch (e) {
      console.error("Registration Failed", e);
    }
  },

  /**
   * Registers the user as a Guest to obtain an Opaque Access Token
   */
  register: async () => {
    // Note: register endpoint might be different from base API.
    // Using simple logic to strip /apps/... from base if needed, or just append /register to appId base.
    // BaseUrl: https://.../rtmsAPI/api/v3
    // Target: https://.../rtmsAPI/api/v3/{appId}/register

    // Check if baseUrl ends with slash
    const base = CONFIG.baseUrl.endsWith('/') ? CONFIG.baseUrl.slice(0, -1) : CONFIG.baseUrl;
    const url = `${base}/${CONFIG.appId}/register`;

    const headers = {
      'Content-Type': 'application/json',
      'secretkey': CONFIG.clientKey,
      'sdkversion': '2.0.0'
    };

    const body = {
      tenant: "1",
      userId: CONFIG.userId,
      channel: "rt",
      channelType: "web",
      deviceId: CONFIG.deviceId,
      data: {
        update: {
          useragent: navigator.userAgent,
          os: "web",
          osversion: "1.0",
          language: navigator.language || "en-US"
        }
      }
    };

    console.log('Registering Guest User...', url);
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      console.error(`Registration failed: ${response.status}`);
      // Fallback: Check if response is valid JSON even on error
    }

    const json = await response.json();
    if (json.accessToken) {
      console.log('Registration Success. Token:', json.accessToken);
      CONFIG.accessToken = json.accessToken;
      return json.accessToken;
    } else {
      console.error('Registration response missing accessToken', json);
      return '';
    }
  },

  // Deprecated: generateJwt (Removed functionality)
  generateJwt: async () => {
    return '';
  },

  getAuthData: async () => {
    if (!CONFIG.accessToken) {
      console.warn('No Access Token. Attempting lazy registration...');
      await WebexClient.register();
    }

    const headers = {
      'Content-Type': 'application/json',
      'accesstoken': CONFIG.accessToken,
      'secretkey': CONFIG.clientKey,
      'sdkversion': '2.0.0'
    };
    return { jwt: CONFIG.accessToken, headers };
  },

  getThreads: async () => {
    const url = `${CONFIG.baseUrl}/apps/${CONFIG.appId}/user/${CONFIG.userId}/threads?start=0&limit=9999`;
    const { headers } = await WebexClient.getAuthData();
    const response = await fetch(url, { headers });
    if (!response.ok) {
      if (response.status === 401) console.error('Authentication Failed');
      throw new Error(`Failed to fetch threads: ${response.statusText}`);
    }
    const data = await response.json();
    return data.threads || [];
  },

  createThread: async () => {
    const url = `${CONFIG.baseUrl}/apps/${CONFIG.appId}/threads`;
    const body = {
      title: `${Date.now()}_wrapper`,
      type: "Conversation",
      status: "Active"
    };
    const { headers } = await WebexClient.getAuthData();
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const err = await response.text();
      console.error('Create thread failed', response.status, err);
      throw new Error(`Failed to create thread: ${response.status} ${err}`);
    }
    const data = await response.json();
    console.log('Create thread response', data);
    return data.thread;
  },

  uploadFile: async (file) => {
    // Standard IMI/Webex Connect Asset Upload
    // POST /apps/{appId}/assets
    const url = `${CONFIG.baseUrl}/apps/${CONFIG.appId}/assets`;
    const { headers } = await WebexClient.getAuthData();

    // Create FormData
    const formData = new FormData();
    formData.append('file', file);
    formData.append('type', 'attachment'); // Optional, depending on API requirements

    // Remove Content-Type header to let browser set boundary for FormData
    const uploadHeaders = { ...headers };
    delete uploadHeaders['Content-Type'];

    console.log('Uploading file...', file.name);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: uploadHeaders,
        body: formData
      });

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`);
      }

      const data = await response.json();
      console.log('Upload success:', data);
      return data; // Should contain assetId, url, etc.
    } catch (e) {
      console.error('Upload error', e);
      throw e;
    }
  },

  sendMessage: async (threadId, text, media = null, options = {}) => {
    const url = `${CONFIG.baseUrl}/${CONFIG.appId}/mo`;
    const body = {
      clientId: CONFIG.clientId,
      channel: "rt",
      thread: {
        id: threadId,
        title: "Conversation",
        type: "Conversation"
      },
      extras: {
        browserfingerprint: CONFIG.userId,
        proactive_id: 0,
        Website: "kp.cz",
        website_id: 6619,
        Webpage: "https://media.imi.chat/widget/widgetloader.html?docwidth=1686&id=30EC647F-3866-49C6-8090-5DA1CC0FB14B&org=",
        customprofileparams: "j7W1zvAMDPaJctzg9ALHEANj9/LMsRYfkVhzpx9qaM3vySWbk8gsVk8o7rRU5OVD",
        hasprechatform: "0",
        "Initiated from URL": "https://kp.cz/~jarda/demo/",
        initiatedon: "",
        "Browser language": navigator.language || "en-US",
        useragent: navigator.userAgent
      },
      outgoing: true,
      ...options // Merge additional options like relatedTid and interactiveData
    };

    if (text) {
      body.message = text;
    }
    if (media) {
      body.media = media;
    }

    // IMPORTANT correction: sendMessage also needs auth headers
    const { headers, jwt } = await WebexClient.getAuthData();

    // Ensure clientId in payload matches MQTT ClientID (with suffix)
    // otherwise backend replies to the wrong (base) client ID.
    // body.clientId = `${CONFIG.clientId}/at_${jwt}`; 
    // CORRECTION: Reference trace chat1.har shows sendMessage uses BASE ClientID (no suffix).
    // MQTT Connect uses Suffix.
    // So we KEEP body.clientId as CONFIG.clientId (as set in line 181).

    console.log('Message Payload:', JSON.stringify(body, null, 2));

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });

      console.log('Fetch response status:', response.status);

      if (!response.ok) {
        const err = await response.text();
        console.error('Send failed', err);
        throw new Error('Failed to send message');
      }
      return await response.json();
    } catch (error) {
      console.error('Fetch error:', error);
      throw error;
    }
  },

  fetchHistory: async (threadId) => {
    // The user pointed out 'history' is not in the docs. The resource is likely 'messages'.
    // URL: https://.../apps/{appId}/user/{userId}/threads/{threadId}/messages?limit=100
    const url = `${CONFIG.baseUrl}/apps/${CONFIG.appId}/user/${CONFIG.userId}/threads/${threadId}/messages?limit=100`;
    const { headers } = await WebexClient.getAuthData();

    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error(`Failed to fetch messages: ${response.statusText}`);
      }
      const data = await response.json();
      return data.messages || [];
    } catch (e) {
      console.error('Message fetch failed', e);
      return [];
    }
  },

  getJwt: async () => {
    const { jwt } = await WebexClient.getAuthData();
    return jwt;
  },

  getMqttCredentials: async () => {
    const { jwt, headers } = await WebexClient.getAuthData();
    const secretKey = headers.secretkey;

    // Construct derived MQTT values
    // Client ID format: {baseClientId}/at_{jwt}
    const mqttClientId = `${CONFIG.clientId}/at_${jwt}`;

    // Username format: {appId}/{userId}
    // Note: Reference trace used slash, but strict auth here fails with it.
    // Trying NO SLASH for Username, but keeping SLASH for Topic.
    const username = `${CONFIG.appId}/${CONFIG.userId}`;

    const password = secretKey;

    return {
      clientId: mqttClientId,
      username: username,
      password: password
    };
  },

  getUserId: () => {
    return CONFIG.userId;
  }
};

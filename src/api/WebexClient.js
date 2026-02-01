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
  deviceId: '',
  widgetId: '', // Captured from URL parameter 'id' (legacy hdr_install_id), also used for upload support
  clientHost: '', // Added for configurable host headers
  websiteId: '', // Added for message extras
  customProfileParams: '', // Added for message extras
  mqttHost: '', // Added for externalized MQTT host
};

export const WebexClient = {
  initialize: async (config) => {
    Object.assign(CONFIG, config);

    // Default fallbacks if blank (legacy support logic) or validation could be added here

    // Restore Access Token from local storage if not provided logic
    if (!CONFIG.accessToken) {
      CONFIG.accessToken = localStorage.getItem('webex_access_token') || '';
    }

    // Generate or retrieve User ID if not provided
    if (!CONFIG.userId) {
      // FIX: Check localStorage for legacy 'browserfingerprint' first!
      // This ensures we use the same ID that the legacy widget used, which is required for
      // the upload token authorization to match existing sessions on the backend.
      let storedUserId = localStorage.getItem('browserfingerprint') || localStorage.getItem('webex_user_id');

      if (!storedUserId) {
        storedUserId = crypto.randomUUID();
        localStorage.setItem('webex_user_id', storedUserId);
      } else {
        // If we found a legacy ID, ensure it's also saved as our new key for consistency
        localStorage.setItem('webex_user_id', storedUserId);
      }
      CONFIG.userId = storedUserId;
    }

    // Capture Widget ID (legacy hdr_install_id) from URL or SessionStorage or Config
    // Prioritize passed config, then URL, then SessionStorage
    const urlParams = new URLSearchParams(window.location.search);
    CONFIG.widgetId = CONFIG.widgetId || urlParams.get('id') || sessionStorage.getItem('webex_engage_data-bind') || '';
    if (!CONFIG.widgetId) {
      console.warn('WebexClient: Widget ID (id param) not found. Uploads may fail.');
    }
    console.log('WebexClient Initialized. UserID:', CONFIG.userId, 'WidgetID:', CONFIG.widgetId);

    // Generate Client ID
    // Format: appId/userId/deviceId
    let deviceId = localStorage.getItem('webex_device_id');

    // VALIDATION: Ensure deviceId is valid (starts with v2_web_ and has NO dashes)
    // Legacy IDs might be raw UUIDs or have dashes.
    const isValidDeviceId = (id) => id && id.startsWith('v2_web_') && !id.includes('-');

    if (!isValidDeviceId(deviceId)) {
      console.warn('WebexClient: Found invalid/legacy Device ID:', deviceId, 'Regenerating...');
      // Generate new compatible ID: v2_web_ + UUID(no dashes)
      const rawId = crypto.randomUUID().replace(/-/g, '');
      deviceId = `v2_web_${rawId}`;
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
      localStorage.setItem('webex_access_token', json.accessToken);
      return json.accessToken;
    } else {
      console.error('Registration response missing accessToken', json);
      return '';
    }
  },

  /**
   * Fetches the official JWT for File Upload authorization from /oauth/token
   * replacing the previous local generation method.
   */
  fetchUploadToken: async () => {
    try {
      // Credentials for Basic Auth: UserID : WidgetID
      // Legacy code Sendoauthheaders() uses: browserFingerprint (userId) : hdr_install_id (widgetId)
      // AND sends client_host header.
      const credentials = `${CONFIG.userId}:${CONFIG.widgetId}`;
      const encodedCredentials = btoa(credentials);

      const url = 'https://chat-widget.imi.chat/oauth/token';

      console.log('Fetching Upload Token from:', url);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${encodedCredentials}`,
          'grant_type': 'client_credentials',
          'client_host': window.location.hostname // Required by legacy backend
        },
        body: '' // Empty body as params are in headers
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Token fetch failed:', response.status, errorText);
        throw new Error(`Token fetch failed: ${response.status}`);
      }

      const json = await response.json();
      if (json.access_token) {
        console.log('Upload Token Fetched successfully.');
        return json.access_token;
      } else {
        throw new Error('Response missing access_token');
      }

    } catch (e) {
      console.error('Error fetching upload token:', e);
      return null;
    }
  },

  /**
   * getAuthData returns the headers required for authorized requests.
   * Note for Upload: We prefer the specific JWT fetched via fetchUploadToken over the opaque registration token.
   */
  getAuthData: async () => {
    if (!CONFIG.accessToken) {
      await WebexClient.register();
    }
    const headers = {
      'Content-Type': 'application/json',
      'accesstoken': CONFIG.accessToken, // Restore accesstoken header for standard API

      'secretkey': CONFIG.clientKey
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

  /**
   * Uploads a file using the direct IMI upload endpoint and Authenticated JWT.
   */
  uploadFile: (file, onProgress) => {
    return new Promise(async (resolve, reject) => {
      // Direct URL
      const url = 'https://chat-widget.imi.chat/upload';

      // Create FormData with required fields from chat45.har
      const formData = new FormData();
      formData.append('AppId', CONFIG.appId);
      formData.append('EnableShortLivedUrl', '1');
      formData.append('file', file);
      // Note: 'Content-Type' for file part is handled by browser/FormData

      // Helper to format 32-char hex as UUID
      const toUuid = (hex) => {
        const clean = hex.replace(/[^a-fA-F0-9]/g, '');
        if (clean.length !== 32) return hex; // Return as-is if not valid hex UUID
        return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
      };

      // Ensure deviceId is retrieved from ClientID if CONFIG.deviceId is missing/empty
      // ClientID format: AppId/UserId/DeviceId
      let effectiveDeviceId = CONFIG.deviceId;
      if (!effectiveDeviceId && CONFIG.clientId) {
        const parts = CONFIG.clientId.split('/');
        if (parts.length >= 3) {
          effectiveDeviceId = parts[parts.length - 1];
        }
      }

      // FIX: X-installId header must match the widgetId (instid claim) in the JWT token.
      const formattedInstallId = toUuid((CONFIG.widgetId || crypto.randomUUID()).replace('v2_web_', '')).toUpperCase();
      const formattedUserId = toUuid((CONFIG.userId || crypto.randomUUID()).replace('v2_web_', '')).toLowerCase();

      // Fetch proper JWT for upload
      let uploadToken;
      try {
        uploadToken = await WebexClient.fetchUploadToken();
      } catch (e) {
        console.warn('Failed to fetch upload token', e);
      }
      const authToken = uploadToken ? `Bearer ${uploadToken}` : (CONFIG.accessToken ? `Bearer ${CONFIG.accessToken}` : '');

      // XMLHttpRequest for Progress
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);

      // Headers (Strictly aligned with imichatwidgetv2.js and chat1-3.har validation)
      xhr.setRequestHeader('x-Fpid', formattedUserId);
      xhr.setRequestHeader('Authorization', authToken);
      xhr.setRequestHeader('X-installId', formattedInstallId);
      xhr.setRequestHeader('client_host', window.location.hostname); // Required by backend
      xhr.setRequestHeader('x-Id', '');
      xhr.setRequestHeader('x-TId', '');
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('x-requested-with', 'XMLHttpRequest');

      // DO NOT set Content-Type header when using FormData, browser sets it with boundary

      // Progress Listener
      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const percent = (e.loaded / e.total) * 100;
            onProgress(percent);
          }
        };
      }

      xhr.onload = () => {
        console.log('Upload response status:', xhr.status);
        const text = xhr.responseText;

        if (xhr.status >= 200 && xhr.status < 300) {
          let data = {};
          try {
            data = text ? JSON.parse(text) : {};
          } catch (e) {
            console.warn('Upload: Could not parse response as JSON', e);
          }
          console.log('Upload success:', data);
          resolve(data);
        } else {
          const error = new Error(`Upload failed with status ${xhr.status}: ${text}`);
          console.error('Upload error', error);
          reject(error);
        }
      };

      xhr.onerror = () => {
        const error = new Error('Upload network error');
        console.error('Upload error', error);
        reject(error);
      };

      console.log('Uploading file...', file.name, url);
      xhr.send(formData);
    });
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
        Website: CONFIG.clientHost || "example.com",
        website_id: CONFIG.websiteId || "0",
        // Dynamically construct logic URL if needed, or just pass simple metadata
        Webpage: `https://media.imi.chat/widget/widgetloader.html?docwidth=1686&id=${CONFIG.widgetId}&org=`,
        customprofileparams: CONFIG.customProfileParams || "",
        hasprechatform: "0",
        "Initiated from URL": window.location.href, // Dynamic URL
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

    // Clean comments
    // body.clientId = `${CONFIG.clientId}/at_${jwt}`; // REMOVED as per trace

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
      password: password,
      host: CONFIG.mqttHost // Return configured host
    };
  },

  getUserId: () => {
    return CONFIG.userId;
  }
};

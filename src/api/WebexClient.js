import { initEncryption, isEncryptionReady, encryptMessage, wrapEncrypted, maybeDecrypt } from './MessageCrypto.js';

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
  contextParams: {}, // Campaign / customer opaque tokens set by the host page
  encryptionEnabled: false, // Set to true when register response has encryption=1
  appDomain: '', // appDomain from register response — used for upload URL and livechat base
  widgetToken: '', // Bearer token from /oauth/token — used for widget-layer (livechat) endpoints
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

    // Perform Registration to get Access Token.
    // register() also reads broker.ip + appDomain from the response to set mqttHost/baseUrl.
    try {
      await WebexClient.register();
      // After successful registration, obtain widget-layer oauth token
      await WebexClient.widgetAuth();
    } catch (e) {
      console.error("Registration Failed", e);
    }
  },

  /**
   * Calls the global verifyPolicy endpoint to get broker (MQTT) and appDomain (base URL).
   * Works for all regions via the fixed gateway rtm.imiconnect.eu.
   * Kept as utility but no longer called separately during initialize.
   */
  verifyPolicy: async () => {
    const url = `https://rtm.imiconnect.eu/rtmsAPI/api/v3/${CONFIG.appId}/verifyPolicy?os=chrome&secretKey=${encodeURIComponent(CONFIG.clientKey)}`;
    try {
      const response = await fetch(url, { method: 'GET' });
      if (!response.ok) return null;
      return await response.json();
    } catch (e) {
      console.warn('[WebexClient] verifyPolicy fetch error:', e);
      return null;
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

    // register always uses the global gateway — same for all regions
    const registerBase = 'https://rtm.imiconnect.eu/rtmsAPI/api/v3';
    const url = `${registerBase}/${CONFIG.appId}/register`;

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
    }

    const json = await response.json();
    if (json.accessToken) {
      console.log('Registration Success. Token:', json.accessToken);
      CONFIG.accessToken = json.accessToken;
      localStorage.setItem('webex_access_token', json.accessToken);

      // Read broker and appDomain from register response
      if (json.broker && json.broker.ip) {
        CONFIG.mqttHost = json.broker.ip.toLowerCase();
        console.log('[WebexClient] mqttHost from register response:', CONFIG.mqttHost);
      }
      if (json.appDomain) {
        CONFIG.appDomain = json.appDomain;
        console.log('[WebexClient] appDomain from register response:', CONFIG.appDomain);
      }

      // Encryption: initialise if the policy says encryption=1 and key is present
      const encEnabled = json.policy?.features?.encryption === '1';
      const encKey = json.encryptionKey;
      if (encEnabled && encKey) {
        CONFIG.encryptionEnabled = true;
        await initEncryption(encKey);
        console.log('[WebexClient] Encryption enabled (AES-256-CBC). Type:', json.encryptionType || 'AES');
      } else {
        CONFIG.encryptionEnabled = false;
        console.log('[WebexClient] Encryption disabled (policy.features.encryption =', json.policy?.features?.encryption, ')');
      }

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
      // Ensure we have a valid access token
      if (!CONFIG.accessToken) {
        console.log('[WebexClient] uploadFile: accessToken missing, running register()...');
        try { await WebexClient.register(); } catch(e) { console.warn('register() failed:', e); }
      }
      if (!CONFIG.accessToken) {
        reject(new Error('No access token available for upload'));
        return;
      }

      // Build the SDK upload URL:
      // {appDomain}/rtmsAPI/api/v1/media/{appId}/upload?previewRequired=true&fileUrlRequired=true
      // appDomain comes from the register response; fall back to baseUrl-derived domain.
      let uploadBase;
      if (CONFIG.appDomain) {
        // appDomain is just a hostname, e.g. "tenant-usor.us.webexconnect.io"
        uploadBase = `https://${CONFIG.appDomain}/rtmsAPI/api/v1`;
      } else {
        // Derive from baseUrl: replace /api/v3 with /api/v1
        uploadBase = CONFIG.baseUrl.replace('/api/v3', '/api/v1');
      }
      const url = `${uploadBase}/media/${CONFIG.appId}/upload?previewRequired=true&fileUrlRequired=true`;

      console.log('[WebexClient] uploadFile: URL:', url);

      // FormData: field name is "media" (per original SDK)
      const formData = new FormData();
      formData.append('media', file);

      // XMLHttpRequest for progress
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);

      // Headers matching the original SDK (imiclient.js ICMediaFileManager.uploadFile)
      xhr.setRequestHeader('secretKey', CONFIG.clientKey);
      xhr.setRequestHeader('sdkversion', '2.0.0');
      xhr.setRequestHeader('accessToken', CONFIG.accessToken);
      xhr.setRequestHeader('media-type', file.type || 'application/octet-stream');

      // Progress listener
      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            onProgress((e.loaded / e.total) * 100);
          }
        };
      }

      xhr.onload = () => {
        console.log('[WebexClient] Upload response status:', xhr.status);
        const text = xhr.responseText;

        if (xhr.status >= 200 && xhr.status < 300) {
          let data = {};
          try {
            data = text ? JSON.parse(text) : {};
          } catch (e) {
            console.warn('[WebexClient] Upload: Could not parse response as JSON', e);
          }
          console.log('[WebexClient] Upload success. mediaId:', data.mediaId, '| response:', JSON.stringify(data).substring(0, 300));

          if (data.mediaId) {
            // The SDK returns { mediaId: "4435692935633384", file: "https://..." }
            // We pass the raw fields to the caller.
            resolve({
              mediaId: data.mediaId,
              file: data.file || '',
              contentType: file.type || 'application/octet-stream'
            });
          } else {
            console.warn('[WebexClient] Upload returned no mediaId:', data);
            reject(new Error('Upload response missing mediaId'));
          }
        } else {
          const error = new Error(`Upload failed with status ${xhr.status}: ${text}`);
          console.error('[WebexClient] Upload error', error);
          reject(error);
        }
      };

      xhr.onerror = () => {
        const error = new Error('Upload network error');
        console.error('[WebexClient] Upload error', error);
        reject(error);
      };

      console.log('[WebexClient] Uploading file...', file.name, url);
      xhr.send(formData);
    });
  },

  sendMessage: async (threadId, text, media = null, options = {}) => {
    const url = `${CONFIG.baseUrl}/${CONFIG.appId}/mo`;
    // Build body as a plain object first, then encrypt if required
    const rawBody = {
      clientId: CONFIG.clientId,
      channel: "rt",
      thread: {
        id: threadId,
        title: "Conversation",
        type: "Conversation"
      },
      outgoing: true,
      ...options,
      extras: {
        browserfingerprint: CONFIG.userId,
        proactive_id: 0,
        Website: CONFIG.clientHost || "example.com",
        website_id: CONFIG.websiteId || "0",
        Webpage: `https://media.imi.chat/widget/widgetloader.html?docwidth=1686&id=${CONFIG.widgetId}&org=`,
        customprofileparams: CONFIG.customProfileParams || "",
        hasprechatform: "0",
        "Initiated from URL": window.location.href,
        initiatedon: "",
        "Browser language": navigator.language || "en-US",
        browser_languages: (navigator.languages && navigator.languages.length ? navigator.languages.join(',') : navigator.language) || "en-US",
        useragent: navigator.userAgent,
        // Merge host-page context tokens (e.g. campaignToken, customerToken) last
        // so they take precedence over defaults.
        ...CONFIG.contextParams,
        ...(options.extras || {})
      }
    };

    if (text) rawBody.message = text;
    else rawBody.message = ''; // Always include message field (original SDK does this)
    if (media) rawBody.media = media;

    // Encrypt the payload if encryption is active
    let bodyStr;
    if (isEncryptionReady()) {
      const plaintext = JSON.stringify(rawBody);
      const ciphertext = await encryptMessage(plaintext);
      bodyStr = wrapEncrypted(ciphertext);
      console.log('[WebexClient] Sending encrypted message.');
    } else {
      bodyStr = JSON.stringify(rawBody);
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

    console.log('[WebexClient] Message Payload (pre-encrypt):', JSON.stringify(rawBody, null, 2).substring(0, 2000));

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: bodyStr
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
    const url = `${CONFIG.baseUrl}/apps/${CONFIG.appId}/user/${CONFIG.userId}/threads/${threadId}/messages?limit=100`;
    const { headers } = await WebexClient.getAuthData();

    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error(`Failed to fetch messages: ${response.statusText}`);
      }
      // When encryption is active the body may be { "encrypted": "<b64>" }
      let data;
      if (CONFIG.encryptionEnabled) {
        const rawText = await response.text();
        const plain = await maybeDecrypt(rawText);
        data = JSON.parse(plain);
      } else {
        data = await response.json();
      }
      return data.messages || [];
    } catch (e) {
      console.error('Message fetch failed', e);
      return [];
    }
  },

  fetchThreads: async () => {
    const url = `${CONFIG.baseUrl}/apps/${CONFIG.appId}/user/${CONFIG.userId}/threads`;
    const { headers } = await WebexClient.getAuthData();

    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error(`Failed to fetch threads: ${response.statusText}`);
      }
      let data;
      if (CONFIG.encryptionEnabled) {
        const rawText = await response.text();
        const plain = await maybeDecrypt(rawText);
        data = JSON.parse(plain);
      } else {
        data = await response.json();
      }
      return data.threads || [];
    } catch (e) {
      console.error('Thread fetch failed', e);
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
  },

  /**
   * Store opaque context tokens (e.g. { campaignToken, customerToken }) supplied
   * by the host page. They will be merged into extras on every sendMessage() call.
   * Calling this method again replaces the previous context entirely.
   */
  setContextParams: (params) => {
    CONFIG.contextParams = params && typeof params === 'object' ? { ...params } : {};
    console.log('[WebexClient] Context params set:', CONFIG.contextParams);
  },

  /**
   * Returns true if AES-256-CBC encryption is currently active for this session.
   * Used by RealtimeClient to know whether to decrypt incoming MQTT messages.
   */
  isEncryptionEnabled: () => CONFIG.encryptionEnabled,

  // ─── Widget-layer OAuth (Live Chat Protocol) ───────────────────────────

  /**
   * Obtains a widget-layer Bearer token via POST {appDomain}/oauth/token.
   * Mirrors the original IMILiveChat.authorization() flow.
   *
   * Sendoauthheaders format:
   *   grant_type: "client_credentials"
   *   client_host: hostname
   *   Authorization: "Basic " + btoa(browserFingerprint + ":" + installId)
   */
  widgetAuth: async () => {
    const baseUrl = WebexClient._livechatBaseUrl();
    if (!baseUrl) {
      console.warn('[WebexClient] widgetAuth skipped — appDomain not yet available');
      return;
    }
    const url = `${baseUrl}/oauth/token`;
    const credentials = btoa(`${CONFIG.userId}:${CONFIG.widgetId}`);

    try {
      console.log('[WebexClient] widgetAuth calling:', url);
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'grant_type': 'client_credentials',
          'client_host': CONFIG.clientHost || window.location.hostname,
          'Authorization': `Basic ${credentials}`
        },
        body: ''
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.info('[WebexClient] widgetAuth unavailable (expected when cross-origin):', resp.status);
        return;
      }

      const data = await resp.json();
      if (data.access_token) {
        CONFIG.widgetToken = data.access_token;
        console.log('[WebexClient] widgetAuth succeeded — widget Bearer token obtained');

        // The original code decodes the JWT and checks for a realm field
        // to update profileUrl. We log it for debugging but our baseUrl
        // is already set from the register response.
        try {
          const payload = JSON.parse(atob(data.access_token.split('.')[1]));
          if (payload.realm) {
            console.log('[WebexClient] widgetAuth JWT realm:', payload.realm);
          }
        } catch (_) { /* JWT decode optional */ }
      } else {
        console.warn('[WebexClient] widgetAuth response missing access_token:', data);
      }
    } catch (e) {
      // CORS errors are expected when running cross-origin (not inside iframe)
      console.info('[WebexClient] widgetAuth unavailable (cross-origin) — livechat lifecycle calls will be skipped');
    }
  },

  /**
   * Returns the base URL for livechat endpoints (derived from appDomain).
   * Matches the original IMIGeneral.profileUrl() which is https://{appDomain}/
   */
  _livechatBaseUrl: () => {
    if (CONFIG.appDomain) {
      return `https://${CONFIG.appDomain}`;
    }
    // Fallback to SDK baseUrl without /api/v3
    return CONFIG.baseUrl ? CONFIG.baseUrl.replace('/api/v3', '') : '';
  },

  /**
   * Widget-layer auth headers for /livechats/* endpoints.
   * Mirrors the original Sendheaders() from imichatwidgetv2.js.
   */
  _getWidgetHeaders: () => ({
    'Content-Type': 'application/json',
    'x-Fpid': CONFIG.userId,
    'Authorization': CONFIG.widgetToken ? `Bearer ${CONFIG.widgetToken}` : '',
    'x-installId': CONFIG.widgetId || '',
    'x-TID': '',
    'x-ID': '',
    'client_host': CONFIG.clientHost || window.location.hostname
  }),

  /** Returns true if widget-layer oauth succeeded (same-origin / iframe mode). */
  _hasWidgetAuth: () => !!CONFIG.widgetToken,

  // ─── Live Chat Lifecycle APIs ──────────────────────────────────────────

  /**
   * Notifies the server the chat has ended.
   * Original: POST {profileUrl}livechats/endchat
   */
  endChat: async (threadId) => {
    if (!WebexClient._hasWidgetAuth()) return; // Cross-origin — skip
    const url = `${WebexClient._livechatBaseUrl()}/livechats/endchat`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: WebexClient._getWidgetHeaders(),
        body: JSON.stringify({
          teamappid: CONFIG.clientId,
          browserfingerprint: CONFIG.userId,
          appid: CONFIG.appId,
          threadid: threadId,
          hostname: CONFIG.clientHost || window.location.hostname
        })
      });
      console.log('[WebexClient] endChat response:', resp.status);
    } catch (e) {
      console.warn('[WebexClient] endChat failed:', e.message);
    }
  },

  /**
   * Notifies the server that the customer's connection was lost.
   * Original: POST {profileUrl}livechats/{appId}/customers/{fpid}/connectionlost
   */
  notifyConnectionLost: async (status = 0) => {
    if (!WebexClient._hasWidgetAuth()) return; // Cross-origin — skip
    const base = WebexClient._livechatBaseUrl();
    const url = `${base}/livechats/${CONFIG.appId}/customers/${CONFIG.userId}/connectionlost?host=${encodeURIComponent(CONFIG.clientHost || window.location.hostname)}`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: WebexClient._getWidgetHeaders(),
        body: JSON.stringify({ connection_status: status })
      });
      console.log('[WebexClient] notifyConnectionLost response:', resp.status);
    } catch (e) {
      console.warn('[WebexClient] notifyConnectionLost failed:', e.message);
    }
  },

  /**
   * Notifies the server the customer closed/reloaded the browser.
   * Original: POST {profileUrl}livechats/{appId}/customers/{fpid}/browserclosed
   */
  notifyBrowserClosed: (isReloaded = false) => {
    if (!WebexClient._hasWidgetAuth()) return; // Cross-origin — skip
    const base = WebexClient._livechatBaseUrl();
    const url = `${base}/livechats/${CONFIG.appId}/customers/${CONFIG.userId}/browserclosed?host=${encodeURIComponent(CONFIG.clientHost || window.location.hostname)}`;
    const payload = JSON.stringify({ is_reloaded: isReloaded });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
      console.log('[WebexClient] notifyBrowserClosed sent via sendBeacon');
    } else {
      fetch(url, {
        method: 'POST',
        headers: WebexClient._getWidgetHeaders(),
        body: payload,
        keepalive: true
      }).catch(() => {});
    }
  },

  /**
   * Notifies the server the customer abandoned the chat.
   * Original: POST {profileUrl}livechats/{appId}/customers/{fpid}/abandoned
   */
  notifyAbandoned: (isReloaded = false, isCloseChat = false) => {
    if (!WebexClient._hasWidgetAuth()) return; // Cross-origin — skip
    const base = WebexClient._livechatBaseUrl();
    const url = `${base}/livechats/${CONFIG.appId}/customers/${CONFIG.userId}/abandoned?host=${encodeURIComponent(CONFIG.clientHost || window.location.hostname)}`;
    const payload = JSON.stringify({ is_reloaded: isReloaded, is_closechat: isCloseChat });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
      console.log('[WebexClient] notifyAbandoned sent via sendBeacon');
    } else {
      fetch(url, {
        method: 'POST',
        headers: WebexClient._getWidgetHeaders(),
        body: payload,
        keepalive: true
      }).catch(() => {});
    }
  },

  // ─── Delivery / Read Receipts ──────────────────────────────────────────

  /**
   * Sends a delivery receipt (status=2) for a single message.
   * Original: POST /{appId}/deliveryupdate
   */
  sendDeliveryReceipt: async (transactionId) => {
    if (!transactionId) return;
    const url = `${CONFIG.baseUrl}/${CONFIG.appId}/deliveryupdate`;
    const { headers } = await WebexClient.getAuthData();
    const body = {
      status: 2,
      tid: transactionId,
      channel: 'rt',
      clientId: CONFIG.clientId
    };
    let bodyStr;
    if (isEncryptionReady()) {
      bodyStr = wrapEncrypted(await encryptMessage(JSON.stringify(body)));
    } else {
      bodyStr = JSON.stringify(body);
    }
    try {
      await fetch(url, { method: 'POST', headers, body: bodyStr });
    } catch (e) {
      console.warn('[WebexClient] sendDeliveryReceipt failed:', e.message);
    }
  },

  /**
   * Marks messages as read (status=3).
   * Original: POST /{appId}/deliveryupdate with { tids: [...], status: 3 }
   */
  sendReadReceipts: async (transactionIds) => {
    if (!transactionIds || transactionIds.length === 0) return;
    // De-duplicate
    const uniqueTids = [...new Set(transactionIds)];
    const url = `${CONFIG.baseUrl}/${CONFIG.appId}/deliveryupdate`;
    const { headers } = await WebexClient.getAuthData();
    const body = {
      tids: uniqueTids,
      status: 3,
      channel: 'rt',
      clientId: CONFIG.clientId
    };
    let bodyStr;
    if (isEncryptionReady()) {
      bodyStr = wrapEncrypted(await encryptMessage(JSON.stringify(body)));
    } else {
      bodyStr = JSON.stringify(body);
    }
    try {
      await fetch(url, { method: 'POST', headers, body: bodyStr });
      console.log('[WebexClient] Read receipts sent for', uniqueTids.length, 'messages');
    } catch (e) {
      console.warn('[WebexClient] sendReadReceipts failed:', e.message);
    }
  },
};

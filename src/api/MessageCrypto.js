/**
 * MessageCrypto — AES-256-CBC message encryption/decryption
 *
 * Algorithm reverse-engineered from the original imiclient.js (imichat SDK):
 *
 *   ENCRYPT:
 *     1. Generate a random 16-byte IV.
 *     2. Encrypt the plaintext JSON string with AES-256-CBC using the session key + IV.
 *     3. Prepend the IV bytes to the ciphertext bytes.
 *     4. Base64-encode the combined buffer.
 *     5. Wrap: { "encrypted": "<b64>" }
 *
 *   DECRYPT (reverse):
 *     1. Base64-decode the value.
 *     2. First 16 bytes  = IV, remaining bytes = ciphertext.
 *     3. AES-256-CBC decrypt with session key + IV.
 *     4. UTF-8 decode to get the original JSON string.
 *
 * The session key is a Base64-encoded 32-byte (256-bit) AES key delivered by
 * the /register API response in the field `encryptionKey`.
 *
 * Encryption is active when the /register (or /verifyPolicy) response contains:
 *   policy.features.encryption === "1"
 *
 * Uses the native Web Crypto API — no third-party libraries required.
 */

let _cryptoKey = null; // CryptoKey object, set once after register

/**
 * Import the raw Base64 key from the register response and cache it as a
 * native CryptoKey.  Call this once after registration when encryption is on.
 *
 * @param {string} encryptionKeyB64  Base64-encoded 32-byte AES key
 */
export async function initEncryption(encryptionKeyB64) {
  const rawKey = Uint8Array.from(atob(encryptionKeyB64), c => c.charCodeAt(0));
  _cryptoKey = await crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-CBC' },
    false,          // not extractable
    ['encrypt', 'decrypt']
  );
  console.log('[MessageCrypto] AES-256-CBC key imported, encryption active.');
}

/**
 * Returns true if a session key has been imported (i.e. encryption is active).
 */
export function isEncryptionReady() {
  return _cryptoKey !== null;
}

/**
 * Encrypt a plaintext string (the message JSON).
 *
 * @param {string} plaintext  JSON string of the message payload
 * @returns {Promise<string>}  Base64-encoded IV + ciphertext
 */
export async function encryptMessage(plaintext) {
  if (!_cryptoKey) throw new Error('[MessageCrypto] Encryption key not initialised');

  const iv = crypto.getRandomValues(new Uint8Array(16));
  const encoded = new TextEncoder().encode(plaintext);

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv },
    _cryptoKey,
    encoded
  );

  // Prepend IV to ciphertext — matches imiclient.js: header.concat(iv); header.concat(body.ciphertext)
  const combined = new Uint8Array(iv.byteLength + cipherBuffer.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipherBuffer), iv.byteLength);

  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a Base64-encoded encrypted message payload (IV prepended).
 *
 * @param {string} b64  Base64-encoded IV + ciphertext
 * @returns {Promise<string>}  Decrypted plaintext (JSON string)
 */
export async function decryptMessage(b64) {
  if (!_cryptoKey) throw new Error('[MessageCrypto] Encryption key not initialised');

  const combined = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const iv = combined.slice(0, 16);
  const ciphertext = combined.slice(16);

  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv },
    _cryptoKey,
    ciphertext
  );

  return new TextDecoder().decode(plainBuffer);
}

/**
 * Wrap an encrypted ciphertext in the envelope the API expects.
 * @param {string} b64ciphertext
 * @returns {string}  JSON string: {"encrypted":"<b64>"}
 */
export function wrapEncrypted(b64ciphertext) {
  return JSON.stringify({ encrypted: b64ciphertext });
}

/**
 * If the raw string payload is an encrypted envelope, extract and decrypt it.
 * Otherwise return the original string unchanged.
 *
 * @param {string} payload  Raw string from MQTT or REST response
 * @returns {Promise<string>}  Plaintext JSON string
 */
export async function maybeDecrypt(payload) {
  if (!payload || typeof payload !== 'string') return payload;
  try {
    const obj = JSON.parse(payload);
    if (obj && typeof obj.encrypted === 'string') {
      return await decryptMessage(obj.encrypted);
    }
  } catch (_) {
    // Not JSON or not an encrypted envelope — return as-is
  }
  return payload;
}


/**
 * End-to-End Encryption utility using Web Crypto API.
 * Optimized for performance with both strings and raw binary data.
 */

export async function deriveKey(passphrase: string, salt: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );

  return window.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode(salt),
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// 支持加密字符串
export async function encryptMessage(key: CryptoKey, text: string): Promise<{ data: string; iv: string }> {
  const enc = new TextEncoder();
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(text)
  );

  return {
    data: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
    iv: btoa(String.fromCharCode(...iv)),
  };
}

// 支持解密字符串
export async function decryptMessage(key: CryptoKey, data: string, iv: string): Promise<string> {
  const dec = new TextDecoder();
  const encryptedBuffer = new Uint8Array(atob(data).split('').map(c => c.charCodeAt(0)));
  const ivBuffer = new Uint8Array(atob(iv).split('').map(c => c.charCodeAt(0)));

  const decrypted = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBuffer },
    key,
    encryptedBuffer
  );

  return dec.decode(decrypted);
}

// 支持加密二进制 (用于文件分片)
export async function encryptBuffer(key: CryptoKey, buffer: ArrayBuffer): Promise<{ data: ArrayBuffer; iv: Uint8Array }> {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    buffer
  );
  return { data: ciphertext, iv };
}

// 支持解密二进制 (用于文件分片)
export async function decryptBuffer(key: CryptoKey, buffer: ArrayBuffer, iv: Uint8Array): Promise<ArrayBuffer> {
  return await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    buffer
  );
}

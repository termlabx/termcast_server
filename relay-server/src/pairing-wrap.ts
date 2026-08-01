import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const SALT = Buffer.from('termcast-pair-v1', 'utf8');
const INFO = Buffer.from('pairing-secret-wrap', 'utf8');

function deriveKey(token: string): Buffer {
  // HKDF-SHA256 → 32-byte AES key. Deterministic given the token.
  return Buffer.from(hkdfSync('sha256', Buffer.from(token, 'utf8'), SALT, INFO, 32));
}

/** base64( nonce(12) || ciphertext || tag(16) ) — matches CryptoKit "combined". */
export function wrapSecret(secret: string, token: string): string {
  const key = deriveKey(token);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.from(secret, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]).toString('base64');
}

export function unwrapSecret(wrappedBase64: string, token: string): string {
  const raw = Buffer.from(wrappedBase64, 'base64');
  const nonce = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(12, raw.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(token), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

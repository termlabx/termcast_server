import { generateKeyPairSync, diffieHellman, createPrivateKey, createPublicKey, createCipheriv, createDecipheriv, randomBytes, hkdfSync } from 'node:crypto';

// X25519 PKCS8/SPKI DER prefixes for wrapping raw 32-byte keys
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export function generateKeyPair(): { publicKey: Buffer; privateKey: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return {
    publicKey: publicKey.subarray(-32),
    privateKey: privateKey.subarray(-32),
  };
}

export function computeSharedSecret(ourPrivateKeyRaw: Buffer, theirPublicKeyRaw: Buffer): Buffer {
  const privKeyObj = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, ourPrivateKeyRaw]),
    format: 'der',
    type: 'pkcs8',
  });
  const pubKeyObj = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, theirPublicKeyRaw]),
    format: 'der',
    type: 'spki',
  });
  return diffieHellman({ privateKey: privKeyObj, publicKey: pubKeyObj });
}

export function deriveKey(sharedSecret: Buffer): Buffer {
  return Buffer.from(
    hkdfSync('sha256', sharedSecret, Buffer.alloc(0), Buffer.from('ttyd-relay-v1'), 32)
  );
}

export function encrypt(plaintext: Buffer, key: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, tag]);
}

export function decrypt(sealed: Buffer, key: Buffer): Buffer {
  // Minimum: 12-byte nonce + 16-byte auth tag = 28 bytes
  if (sealed.length < 28) {
    throw new Error(`decrypt: buffer too short (${sealed.length} bytes, need >= 28)`);
  }
  const nonce = sealed.subarray(0, 12);
  const tag = sealed.subarray(-16);
  const ciphertext = sealed.subarray(12, -16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

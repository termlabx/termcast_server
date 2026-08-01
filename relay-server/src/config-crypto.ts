import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { encrypt, decrypt } from './crypto.js';

// Secrets at rest in ~/.ttyd-server (the server private key, our pairing secret,
// and the pairing secrets of meshed peers) are encrypted with a local key kept
// in a sibling `key` file. The key never leaves the machine, so a config.json or
// mesh-peers.json that gets copied / backed up / synced / committed elsewhere is
// useless on its own. (This does not defend against another local user or root
// who can read the whole directory — see the security review notes.)

const ENC_PREFIX = 'enc:v1:';

/**
 * Loads the local field-encryption key, creating it (32 random bytes, stored
 * base64 in `<configDir>/key` with 0600 perms) on first use. chmod is applied
 * explicitly so a key file written by an older/again-run process is tightened.
 */
export function loadOrCreateConfigKey(configDir: string): Buffer {
  const keyFile = join(configDir, 'key');
  try {
    if (existsSync(keyFile)) {
      const buf = Buffer.from(readFileSync(keyFile, 'utf-8').trim(), 'base64');
      if (buf.length === 32) return buf;
    }
  } catch {}
  const key = randomBytes(32);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  try { chmodSync(configDir, 0o700); } catch {}
  writeFileSync(keyFile, key.toString('base64'), { mode: 0o600 });
  try { chmodSync(keyFile, 0o600); } catch {}
  return key;
}

/** True when `value` is an `enc:v1:` token produced by encryptField. */
export function isEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

/** Encrypts a UTF-8 string field (AES-256-GCM), returning an `enc:v1:` token. */
export function encryptField(value: string, key: Buffer): string {
  return ENC_PREFIX + encrypt(Buffer.from(value, 'utf8'), key).toString('base64');
}

/**
 * Decrypts an `enc:v1:` token back to its UTF-8 string. Legacy plaintext values
 * (no prefix) are returned unchanged so pre-existing config files keep working
 * and transparently migrate on the next save. Throws if a prefixed token can't
 * be authenticated (wrong or missing key) — callers treat that as "no config".
 */
export function decryptField(value: string, key: Buffer): string {
  if (!isEncrypted(value)) return value;
  const sealed = Buffer.from(value.slice(ENC_PREFIX.length), 'base64');
  return decrypt(sealed, key).toString('utf8');
}

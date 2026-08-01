import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadOrCreateConfigKey, encryptField, decryptField, isEncrypted } from './config-crypto.js';

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'ttyd-cfg-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('round-trips a secret through encrypt/decrypt', () => {
  const key = randomBytes(32);
  const secret = 'super-secret-pairing-token_base64url==';
  const token = encryptField(secret, key);
  assert.ok(isEncrypted(token));
  assert.notEqual(token, secret);
  assert.equal(decryptField(token, key), secret);
});

test('legacy plaintext passes through decrypt unchanged and is not flagged encrypted', () => {
  const key = randomBytes(32);
  const plaintext = 'AAAABBBBCCCCDDDD'; // base64-looking legacy value, no prefix
  assert.equal(isEncrypted(plaintext), false);
  assert.equal(decryptField(plaintext, key), plaintext);
});

test('decrypt with the wrong key throws (auth failure)', () => {
  const token = encryptField('secret', randomBytes(32));
  assert.throws(() => decryptField(token, randomBytes(32)));
});

test('ciphertext does not contain the plaintext', () => {
  const key = randomBytes(32);
  const token = encryptField('NEEDLE-value', key);
  assert.equal(token.includes('NEEDLE'), false);
});

test('loadOrCreateConfigKey creates a stable 32-byte key file with 0600 perms', () => {
  withTempDir((dir) => {
    const k1 = loadOrCreateConfigKey(dir);
    assert.equal(k1.length, 32);
    const keyFile = join(dir, 'key');
    assert.ok(existsSync(keyFile));
    // Owner-only file permissions.
    assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    // Stable across calls.
    const k2 = loadOrCreateConfigKey(dir);
    assert.deepEqual([...k1], [...k2]);
  });
});

test('a value encrypted with the persisted key decrypts after reload', () => {
  withTempDir((dir) => {
    const key = loadOrCreateConfigKey(dir);
    const token = encryptField('persisted', key);
    // Simulate a fresh process re-reading the same key file.
    const reloaded = loadOrCreateConfigKey(dir);
    assert.equal(decryptField(token, reloaded), 'persisted');
    // The on-disk key really is what we read back.
    assert.equal(readFileSync(join(dir, 'key'), 'utf-8').trim(), key.toString('base64'));
  });
});

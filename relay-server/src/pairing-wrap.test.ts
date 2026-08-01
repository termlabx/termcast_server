import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapSecret, unwrapSecret } from './pairing-wrap.js';

test('wrap → unwrap round-trips the secret', () => {
  const secret = 'aVeryLong-Base64url_pairing_secret_value_1234567890';
  const token = 'one-time-token-abc123';
  const wrapped = wrapSecret(secret, token);
  assert.equal(unwrapSecret(wrapped, token), secret);
});

test('a different token fails to unwrap (auth tag mismatch)', () => {
  const wrapped = wrapSecret('s3cr3t', 'token-A');
  assert.throws(() => unwrapSecret(wrapped, 'token-B'));
});

test('wrapped blob is base64 of at least nonce(12)+tag(16)', () => {
  const wrapped = wrapSecret('x', 'tok');
  const raw = Buffer.from(wrapped, 'base64');
  assert.ok(raw.length >= 12 + 16 + 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePairingInfo, qrPayload } from './pairing.js';

test('generatePairingInfo mints a token distinct from the secret', () => {
  const p = generatePairingInfo('wss://r.example', Buffer.alloc(32, 7), 'dev1');
  assert.ok(p.pairingToken.length >= 20);
  assert.notEqual(p.pairingToken, p.pairingSecret);
});

test('each call mints a fresh token', () => {
  const a = generatePairingInfo('wss://r', Buffer.alloc(32, 1), 'dev1');
  const b = generatePairingInfo('wss://r', Buffer.alloc(32, 1), 'dev1');
  assert.notEqual(a.pairingToken, b.pairingToken);
});

test('qrPayload is v2 and omits pairing_secret', () => {
  const p = generatePairingInfo('wss://r', Buffer.alloc(32, 9), 'dev1');
  const obj = JSON.parse(qrPayload(p));
  assert.equal(obj.v, 2);
  assert.equal(obj.pairing_token, p.pairingToken);
  assert.equal('pairing_secret' in obj, false);
});

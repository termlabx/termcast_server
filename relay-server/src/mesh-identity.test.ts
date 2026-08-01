import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVerify, createPublicKey } from 'node:crypto';
import { loadOrCreateMeshKeypair, signMeshChallenge } from './mesh-identity.js';

test('mesh keypair is stable across calls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-'));
  const a = loadOrCreateMeshKeypair(dir);
  const b = loadOrCreateMeshKeypair(dir);
  assert.equal(a.publicKeySpki, b.publicKeySpki);
  assert.equal(a.keyId, b.keyId);
});

test('signature verifies against the published SPKI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-'));
  const kp = loadOrCreateMeshKeypair(dir);
  const clientData = 'challenge|device|client';
  const sig = signMeshChallenge(kp.privateKeyPem, clientData);

  const pub = createPublicKey({
    key: Buffer.from(kp.publicKeySpki, 'base64'),
    format: 'der',
    type: 'spki',
  });
  const v = createVerify('SHA256');
  v.update(clientData);
  assert.equal(v.verify(pub, Buffer.from(sig, 'base64')), true);
});

test('private key is written 0600 — it is the peer credential', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-'));
  loadOrCreateMeshKeypair(dir);
  const mode = statSync(join(dir, 'mesh-key.pem')).mode & 0o777;
  assert.equal(mode, 0o600);
});

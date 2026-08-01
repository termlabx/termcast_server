//
// Mesh peers are Node daemons and cannot use App Attest, but they share the
// /api/connect/client endpoint with the phone. Trusting a User-Agent header to
// tell them apart would make the whole attestation gate decorative — a clone
// would just send that header. So peers carry a real credential: a P-256 key
// registered with the relay, used to sign the same single-use challenges.

import {
  generateKeyPairSync, createSign, createHash, createPrivateKey, createPublicKey,
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export interface MeshKeypair {
  publicKeySpki: string;  // base64 DER SPKI — what the relay stores
  privateKeyPem: string;
  keyId: string;          // base64 SHA-256 of the SPKI
}

export function loadOrCreateMeshKeypair(configDir: string): MeshKeypair {
  const keyFile = join(configDir, 'mesh-key.pem');

  let privateKeyPem: string;
  if (existsSync(keyFile)) {
    privateKeyPem = readFileSync(keyFile, 'utf-8');
  } else {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(keyFile, privateKeyPem, { mode: 0o600 });
    try { chmodSync(keyFile, 0o600); } catch {}
  }

  const pub = createPublicKey(createPrivateKey(privateKeyPem));
  const spki = pub.export({ type: 'spki', format: 'der' }) as Buffer;
  const publicKeySpki = spki.toString('base64');
  const keyId = createHash('sha256').update(spki).digest('base64');

  return { publicKeySpki, privateKeyPem, keyId };
}

/**
 * base64 DER ECDSA signature over the UTF-8 clientData.
 *
 * The relay verifies this with WebCrypto, which wants raw r||s, so it converts
 * the DER back — see verifyMeshSignature in relay-backend/src/relay-room.ts.
 */
export function signMeshChallenge(privateKeyPem: string, clientData: string): string {
  const s = createSign('SHA256');
  s.update(clientData);
  s.end();
  return s.sign(privateKeyPem).toString('base64');
}

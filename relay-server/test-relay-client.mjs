// Test script: simulates iPhone connecting via relay
import WebSocket from 'ws';
import { generateKeyPairSync, diffieHellman, createPrivateKey, createPublicKey, createCipheriv, createDecipheriv, randomBytes, hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

// Read server state
const state = JSON.parse(readFileSync(join(homedir(), '.ttyd-server', 'state.json'), 'utf-8'));
const relayHTTP = state.relayURL.replace('wss://', 'https://').replace('ws://', 'http://');
const serverPubKeyRaw = Buffer.from(state.serverPublicKey, 'base64');

console.log('Device ID:', state.deviceId);
console.log('Relay:', relayHTTP);

// Generate ephemeral keypair (simulating iPhone)
const { publicKey: ephPubDer, privateKey: ephPrivDer } = generateKeyPairSync('x25519', {
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'der' },
});
const ephPubRaw = ephPubDer.subarray(-32);
const ephPrivRaw = ephPrivDer.subarray(-32);

// Derive shared secret
const privKeyObj = createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, ephPrivRaw]), format: 'der', type: 'pkcs8' });
const pubKeyObj = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, serverPubKeyRaw]), format: 'der', type: 'spki' });
const sharedSecret = diffieHellman({ privateKey: privKeyObj, publicKey: pubKeyObj });
const symmetricKey = Buffer.from(hkdfSync('sha256', sharedSecret, Buffer.alloc(0), Buffer.from('ttyd-relay-v1'), 32));

console.log('Symmetric key derived:', symmetricKey.toString('hex').substring(0, 16) + '...');

function encrypt(plaintext, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]);
}

function decrypt(sealed, key) {
  const nonce = sealed.subarray(0, 12);
  const tag = sealed.subarray(-16);
  const ct = sealed.subarray(12, -16);
  const decipher = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// We need a valid pairing secret. Read it from the web UI.
const webUIPort = 8081; // from the server output
const pairingResp = await fetch(`http://127.0.0.1:${webUIPort}/api/pairing`);
const pairingData = await pairingResp.json();
console.log('Pairing secret obtained:', pairingData.pairing_secret ? 'yes' : 'no');

// Connect to relay as client
const wsURL = `${state.relayURL}/api/connect/client?device_id=${state.deviceId}&pairing_secret=${encodeURIComponent(pairingData.pairing_secret)}&client_id=test-client`;
console.log('Connecting to relay...');
const ws = new WebSocket(wsURL);
ws.binaryType = 'arraybuffer';

ws.on('open', () => {
  console.log('WebSocket opened, sending handshake...');
  const handshakeJSON = JSON.stringify({ client_public_key: ephPubRaw.toString('base64') });
  const msg = Buffer.alloc(1 + Buffer.byteLength(handshakeJSON));
  msg[0] = 0x01; // HANDSHAKE
  msg.write(handshakeJSON, 1);
  ws.send(msg);
});

ws.on('message', (data) => {
  const bytes = new Uint8Array(data);
  const type = bytes[0];
  const payload = Buffer.from(bytes.slice(1));

  if (type === 0x02) { // HANDSHAKE_ACK
    console.log('HANDSHAKE_ACK received! Sending test input "ls\\n"...');

    // Send resize first
    const resizeData = Buffer.from('\x31{"columns":80,"rows":24}');
    const encResize = encrypt(resizeData, symmetricKey);
    const resizeMsg = Buffer.alloc(1 + encResize.length);
    resizeMsg[0] = 0x03; // DATA
    encResize.copy(resizeMsg, 1);
    ws.send(resizeMsg);

    // Wait, then send input
    setTimeout(() => {
      const inputData = Buffer.from('\x30ls\n');
      const encInput = encrypt(inputData, symmetricKey);
      const inputMsg = Buffer.alloc(1 + encInput.length);
      inputMsg[0] = 0x03; // DATA
      encInput.copy(inputMsg, 1);
      ws.send(inputMsg);
      console.log('Input sent: "ls\\n"');
    }, 500);
  }

  if (type === 0x03) { // DATA
    try {
      const decrypted = decrypt(payload, symmetricKey);
      const cmd = decrypted[0];
      const content = decrypted.subarray(1);
      if (cmd === 0x30) { // output
        process.stdout.write(`[OUTPUT] ${content.toString().replace(/\n/g, '\\n').replace(/\r/g, '\\r').substring(0, 200)}\n`);
      } else {
        console.log(`[CMD 0x${cmd.toString(16)}] ${content.toString().substring(0, 100)}`);
      }
    } catch (err) {
      console.error('Decryption failed:', err.message);
    }
  }

  if (type === 0x06) { // PONG
    // ignore
  }
  if (type === 0x07) { // SERVER_OFFLINE
    console.log('Server offline!');
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
});

ws.on('close', (code, reason) => {
  console.log(`WebSocket closed: ${code} ${reason}`);
});

// Close after 10 seconds
setTimeout(() => {
  console.log('\nTest complete, closing...');
  ws.close();
  process.exit(0);
}, 10000);

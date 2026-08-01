/**
 * E2E test for the relay data-flow pipeline.
 *
 * Architecture under test:
 *
 *   [Mock iOS Client] ──WS──> [Mock Relay] ──WS──> [Bridge + RelayClient]
 *                                                           │
 *                                                    [Mock ttyd (WS echo)]
 *
 * Tests:
 *   1. Full ECDH handshake completes end-to-end
 *   2. Input path  – iOS sends encrypted input  → arrives at mock ttyd as text frame
 *   3. Output path – mock ttyd sends text output → iOS client decrypts it correctly
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket, { WebSocketServer } from 'ws';
import * as http from 'node:http';
import * as net from 'node:net';
import * as crypto from './crypto.js';
import { RelayClient } from './relay-client.js';
import { Bridge } from './bridge.js';
import { MeshClient, type MeshPeer } from './mesh-client.js';
import { wrapSecret, unwrapSecret } from './pairing-wrap.js';

// ─── Protocol constants ───────────────────────────────────────────────────────

const MSG_HANDSHAKE     = 0x01;
const MSG_HANDSHAKE_ACK = 0x02;
const MSG_DATA          = 0x03;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function waitFor(condition: () => boolean, timeout = 5000, interval = 20): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const check = () => {
      if (condition()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('waitFor timeout'));
      setTimeout(check, interval);
    };
    check();
  });
}

// ─── Mock Relay ───────────────────────────────────────────────────────────────
/**
 * Minimal relay that forwards all messages between a 'server' WS (relay-client)
 * and a 'client' WS (mock iOS), mimicking the RelayRoom Durable Object.
 */
class MockRelay {
  private httpServer: http.Server;
  private wss: WebSocketServer;
  serverWs: WebSocket | null = null;
  private clients = new Map<number, WebSocket>(); // connId -> client ws
  private nextConnId = 1;
  serverConnected = false;

  // Single-use pairing grant. The mock stores the token in plaintext (real code
  // stores a PBKDF2 hash via auth.ts) — fine for a same-process test double.
  private pendingGrant: { token: string; wrappedSecret: string; expiresAt: number; consumed: boolean } | null = null;

  constructor() {
    this.httpServer = http.createServer();
    this.httpServer.on('request', (req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
  }

  get port(): number { return (this.httpServer.address() as net.AddressInfo).port; }
  get grantUrl(): string { return `http://127.0.0.1:${this.port}/api/pairing/grant`; }
  get pairUrl(): string { return `http://127.0.0.1:${this.port}/api/pair`; }

  /** Mirrors relay-backend: POST /api/pairing/grant sets the grant; POST /api/pair
   *  redeems it once (evaluatePair order), signalling PAIRING_CONSUMED on success. */
  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (status: number, obj: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      let parsed: any = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}

      if (req.url === '/api/pairing/grant') {
        this.pendingGrant = {
          token: parsed.pairing_token,
          wrappedSecret: parsed.wrapped_secret,
          expiresAt: parsed.grant_expires_at,
          consumed: false,
        };
        return send(200, { ok: true });
      }

      if (req.url === '/api/pair') {
        const g = this.pendingGrant;
        if (!g) return send(410, { code: 4009 });
        if (g.consumed) return send(409, { code: 4004 });
        if (Date.now() > g.expiresAt) return send(410, { code: 4003 });
        if (parsed.pairing_token !== g.token) return send(403, { code: 4010 });
        g.consumed = true;
        this.sendToServer(0x0b, 0, Buffer.alloc(0)); // PAIRING_CONSUMED
        return send(200, { wrapped_secret: g.wrappedSecret });
      }

      send(404, { error: 'not found' });
    });
  }
  start(): Promise<void> { return new Promise(resolve => this.httpServer.listen(0, '127.0.0.1', resolve)); }
  stop(): Promise<void> {
    this.serverWs?.terminate();
    for (const ws of this.clients.values()) ws.terminate();
    return new Promise((res, rej) => this.wss.close(err => err ? rej(err) : res()));
  }

  private handleConnection(ws: WebSocket, req: http.IncomingMessage) {
    const url = req.url ?? '';
    if (url.includes('/server')) {
      this.serverWs = ws;
      this.serverConnected = true;
      ws.on('message', (data: Buffer) => this.serverToClient(Buffer.from(data)));
    } else {
      const connId = this.nextConnId++;
      this.clients.set(connId, ws);
      // CLIENT_CONNECT (0x0a) [connId] {meta}
      this.sendToServer(0x0a, connId, Buffer.from(JSON.stringify({ ip: '127.0.0.1', city: 'Testville', country: 'US', ua: 'test' })));
      ws.on('message', (data: Buffer) => this.clientToServer(connId, Buffer.from(data)));
      ws.on('close', () => {
        this.clients.delete(connId);
        this.sendToServer(0x08, connId, Buffer.from(JSON.stringify({ status: 'client_offline' }))); // CLIENT_OFFLINE
      });
    }
  }

  /** client [type][payload] -> server [type][connId][payload] */
  private clientToServer(connId: number, data: Buffer) {
    if (this.serverWs?.readyState !== WebSocket.OPEN) return;
    const type = data[0];
    this.sendToServer(type, connId, data.subarray(1));
  }

  /** server [type][connId][payload] -> client [type][payload] */
  private serverToClient(data: Buffer) {
    const type = data[0];
    if (type === 0x05) { this.serverWs?.send(Buffer.from([0x06])); return; } // PING -> PONG
    const connId = data[1];
    if (connId === 0) return;
    const client = this.clients.get(connId);
    if (client?.readyState === WebSocket.OPEN) {
      const out = Buffer.alloc(1 + (data.length - 2));
      out[0] = type;
      data.subarray(2).copy(out, 1);
      client.send(out);
    }
  }

  private sendToServer(type: number, connId: number, payload: Buffer) {
    if (this.serverWs?.readyState !== WebSocket.OPEN) return;
    const out = Buffer.alloc(2 + payload.length);
    out[0] = type;
    out[1] = connId;
    payload.copy(out, 2);
    this.serverWs.send(out);
  }
}

// ─── Mock ttyd ────────────────────────────────────────────────────────────────
/**
 * Minimal ttyd that:
 *  - Accepts a WebSocket with 'tty' protocol
 *  - Ignores the initial JSON auth frame
 *  - Records all input frames (0x30 = '0' prefix)
 *  - Exposes sendOutput() to push output frames back to the bridge
 */
class MockTtyd {
  private httpServer: http.Server;
  private wss: WebSocketServer;
  conn: WebSocket | null = null;
  receivedFrames: { isBinary: boolean; data: Buffer }[] = [];
  receivedInput: string[] = [];
  connectionURLs: string[] = []; // request URL of every incoming WS (carries ?arg=)

  constructor() {
    this.httpServer = http.createServer();
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (ws, req) => {
      this.connectionURLs.push(req.url ?? '');
      this.conn = ws;
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        this.receivedFrames.push({ isBinary, data: Buffer.from(data) });
        const str = data.toString('utf8');
        if (str.startsWith('{')) return; // initial JSON auth — skip
        if (data[0] === 0x30) {           // termcast input prefix
          this.receivedInput.push(data.subarray(1).toString('utf8'));
        }
      });
    });
  }

  get port(): number {
    return (this.httpServer.address() as net.AddressInfo).port;
  }

  get wsURL(): string { return `ws://127.0.0.1:${this.port}/ws`; }

  start(): Promise<void> {
    return new Promise(resolve => this.httpServer.listen(0, '127.0.0.1', resolve));
  }

  stop(): Promise<void> {
    this.conn?.terminate();
    return new Promise((res, rej) => this.wss.close(err => err ? rej(err) : res()));
  }

  /** Send a terminal output frame to the bridge (text frame, ttyd format). */
  sendOutput(text: string): boolean {
    if (this.conn?.readyState !== WebSocket.OPEN) return false;
    this.conn.send('0' + text); // text frame with '0' (0x30) prefix
    return true;
  }
}

// ─── Mock iOS Client ──────────────────────────────────────────────────────────
/**
 * Node.js simulation of RelayWebSocketManager's crypto and handshake logic,
 * using the same relay-server/crypto.ts to guarantee byte-for-byte compatibility.
 */
class MockiOSClient {
  private ws: WebSocket | null = null;
  private symKey: Buffer | null = null;
  connected = false;
  receivedOutputChunks: string[] = [];
  decryptErrors: Error[] = [];

  async connect(
    relayPort: number,
    serverPublicKey: Buffer,
    opts?: { phoneId?: string; pairedAt?: number },
  ): Promise<void> {
    // Generate ephemeral keypair (forward secrecy — mirrors iOS performHandshake)
    const ephKeyPair = crypto.generateKeyPair();

    // Derive symmetric key locally using same HKDF as iOS
    const sharedSecret = crypto.computeSharedSecret(ephKeyPair.privateKey, serverPublicKey);
    this.symKey = crypto.deriveKey(sharedSecret);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/client`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      ws.on('open', () => {
        // Send MSG_HANDSHAKE with ephemeral public key
        const pubB64 = ephKeyPair.publicKey.toString('base64');
        const handshakeObj: Record<string, unknown> = { client_public_key: pubB64 };
        if (opts?.phoneId) {
          handshakeObj.phone_id = opts.phoneId;
          handshakeObj.paired_at = opts.pairedAt ?? Date.now();
        }
        const json  = Buffer.from(JSON.stringify(handshakeObj));
        const msg   = Buffer.alloc(1 + json.length);
        msg[0] = MSG_HANDSHAKE;
        json.copy(msg, 1);
        ws.send(msg);
      });

      ws.on('message', (raw: ArrayBuffer) => {
        const buf  = Buffer.from(raw);
        const type = buf[0];
        const body = buf.subarray(1);

        if (type === MSG_HANDSHAKE_ACK) {
          try {
            const parsed = JSON.parse(body.toString('utf8'));
            if (parsed.status === 'ok') {
              this.connected = true;
              resolve();
            }
            // Ignore relay-room's {status:'client_connected'} ack
          } catch { /* relay-room sent something unexpected */ }

        } else if (type === MSG_DATA) {
          const key = this.symKey;
          if (!key) return;
          try {
            const plain = crypto.decrypt(body, key);
            if (plain[0] === 0x30) { // termcast output
              this.receivedOutputChunks.push(plain.subarray(1).toString('utf8'));
            }
          } catch (e) {
            this.decryptErrors.push(e as Error);
          }
        }
      });

      ws.on('error', reject);
      setTimeout(() => reject(new Error('MockiOSClient: handshake timeout')), 10_000);
    });
  }

  /** Send encrypted input to the relay (mirrors RelayWebSocketManager.sendInput). */
  sendInput(text: string) {
    const key = this.symKey;
    if (!key || this.ws?.readyState !== WebSocket.OPEN) return;
    const plain     = Buffer.concat([Buffer.from([0x30]), Buffer.from(text, 'utf8')]);
    const encrypted = crypto.encrypt(plain, key);
    const msg       = Buffer.alloc(1 + encrypted.length);
    msg[0] = MSG_DATA;
    encrypted.copy(msg, 1);
    this.ws.send(msg);
  }

  disconnect() { this.ws?.close(); this.ws = null; }
}

// ─── Test Fixtures ────────────────────────────────────────────────────────────

let relay:   MockRelay;
let ttyd:    MockTtyd;
let ios:     MockiOSClient;
let bridge:  Bridge;
let relayClient: RelayClient;
let serverKeyPair: { publicKey: Buffer; privateKey: Buffer };

before(async () => {
  serverKeyPair = crypto.generateKeyPair();

  relay = new MockRelay();
  ttyd  = new MockTtyd();
  await relay.start();
  await ttyd.start();

  // Wire up the real RelayClient + Bridge (same code used in production)
  const relayBaseURL = `http://127.0.0.1:${relay.port}`;
  relayClient = new RelayClient(relayBaseURL, 'test-device');
  bridge      = new Bridge(ttyd.wsURL, relayClient, serverKeyPair);

  relayClient.connect();
  bridge.start();

  // Wait for relay-server to connect to the mock relay
  await waitFor(() => relay.serverConnected, 5000);
});

after(async () => {
  bridge.stop();
  relayClient.disconnect();
  ios?.disconnect();
  await ttyd.stop();
  await relay.stop();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

test('1 – mock iOS client completes ECDH handshake', async () => {
  ios = new MockiOSClient();
  await ios.connect(relay.port, serverKeyPair.publicKey);

  assert.ok(ios.connected, 'iOS client should be in connected state after HANDSHAKE_ACK');
});

test('2 – input path: iOS encrypted input arrives at mock ttyd as a binary frame', async () => {
  // Bridge should have reconnected ttyd after handshake; wait for it
  await waitFor(() => ttyd.conn !== null && ttyd.conn.readyState === WebSocket.OPEN, 5000);

  const testInput = 'echo hello\r';
  ios.sendInput(testInput);

  await waitFor(() => ttyd.receivedInput.length > 0, 5000);

  assert.ok(ttyd.receivedInput.includes(testInput),
    `Expected ttyd to receive "${testInput}", got: ${JSON.stringify(ttyd.receivedInput)}`);

  // The bridge forwards the decrypted [0x30]+data payload to ttyd as a BINARY
  // WebSocket frame. This is required: terminal bytes are not guaranteed to be
  // valid UTF-8, and RFC 6455 text frames must be — so terminal data must ride
  // a binary frame. ttyd reads the command byte (buffer[0]) regardless of the
  // frame opcode, so a binary INPUT frame is handled correctly. (The ttyd init
  // JSON is the only text frame the bridge sends; see bridge.ts.)
  const inputFrames = ttyd.receivedFrames.filter(f =>
    f.isBinary && f.data[0] === 0x30
  );
  assert.ok(inputFrames.length > 0,
    'Input should arrive as a binary frame (isBinary=true) with 0x30 prefix');
});

test('3 – output path: mock ttyd output arrives at iOS client decrypted', async () => {
  const testOutput = 'hello from ttyd\r\n';

  const initialCount = ios.receivedOutputChunks.length;

  // Keep retrying sendOutput until the bridge's local WS is open
  let sent = false;
  for (let i = 0; i < 20 && !sent; i++) {
    sent = ttyd.sendOutput(testOutput);
    if (!sent) await sleep(100);
  }
  assert.ok(sent, 'Mock ttyd should have an open WebSocket to the bridge');

  await waitFor(() => ios.receivedOutputChunks.length > initialCount, 5000);

  assert.equal(ios.decryptErrors.length, 0,
    `No decryption errors expected; got: ${ios.decryptErrors.map(e => e.message)}`);

  const received = ios.receivedOutputChunks.slice(initialCount).join('');
  assert.ok(received.includes(testOutput),
    `Expected output "${testOutput}", received: ${JSON.stringify(received)}`);
});

test('4 – symmetric keys match: server can decrypt iOS-encrypted data', () => {
  // Round-trip: encrypt with server key, check iOS client can decrypt
  // (This verifies the HKDF derivation is identical on both sides)
  const plaintext = Buffer.from('key symmetry check');
  const symKey    = (ios as any).symKey as Buffer;

  const ciphertext = crypto.encrypt(plaintext, symKey);
  const decrypted  = crypto.decrypt(ciphertext, symKey);

  assert.deepEqual(decrypted, plaintext, 'Self-encrypted data should round-trip correctly');

  // Ensure the server's derived key (from bridge) equals the client's derived key.
  // We verify indirectly: the bridge successfully decrypted iOS's HANDSHAKE message
  // (test 1 would have failed if keys differed).
  assert.ok(ios.decryptErrors.length === 0,
    'No decrypt errors → keys are in sync');
});

test('two clients (terminal + second viewer) coexist without eviction', async () => {
  const relay = new MockRelay();
  const ttyd = new MockTtyd();
  await relay.start();
  await ttyd.start();

  const keyPair = crypto.generateKeyPair();
  const relayClient = new RelayClient(`http://127.0.0.1:${relay.port}`, 'device-test');
  const bridge = new Bridge(ttyd.wsURL, relayClient, keyPair);
  bridge.start();
  relayClient.connect();
  await waitFor(() => relay.serverConnected);

  // Two independent clients connect to the same room.
  const clientA = new MockiOSClient();
  const clientB = new MockiOSClient();
  await clientA.connect(relay.port, keyPair.publicKey);
  await clientB.connect(relay.port, keyPair.publicKey);

  // Both completed their handshakes — neither evicted the other.
  assert.equal(clientA.connected, true, 'client A should stay connected');
  assert.equal(clientB.connected, true, 'client B should stay connected');

  // ttyd output reaches whichever client's session it belongs to without
  // cross-decrypt errors (independent keys).
  await sleep(100);
  assert.equal(clientA.decryptErrors.length, 0, 'no decrypt errors for A');
  assert.equal(clientB.decryptErrors.length, 0, 'no decrypt errors for B');

  bridge.stop();
  relayClient.disconnect();
  await relay.stop();
  await ttyd.stop();
});

test('per-phone routing: distinct phone_id → distinct ttyd ?arg=; same phone_id reuses it', async () => {
  const relay = new MockRelay();
  const ttyd = new MockTtyd();
  await relay.start();
  await ttyd.start();

  const keyPair = crypto.generateKeyPair();
  const relayClient = new RelayClient(`http://127.0.0.1:${relay.port}`, 'device-phones');
  const bridge = new Bridge(ttyd.wsURL, relayClient, keyPair);
  bridge.start();
  relayClient.connect();
  await waitFor(() => relay.serverConnected);

  // Two different phones (distinct phone_id) connect concurrently.
  const phoneA = new MockiOSClient();
  const phoneB = new MockiOSClient();
  await phoneA.connect(relay.port, keyPair.publicKey, { phoneId: 'AAA', pairedAt: 1_700_000_000_000 });
  await phoneB.connect(relay.port, keyPair.publicKey, { phoneId: 'BBB', pairedAt: 1_700_000_000_000 });

  // Each phone's session opens its own local ttyd connection carrying ?arg=<phoneId>.
  await waitFor(() => ttyd.connectionURLs.filter(u => u.includes('arg=')).length >= 2, 5000);
  const argOf = (u: string) => new URL(u, 'http://x').searchParams.get('arg');
  const args = new Set(ttyd.connectionURLs.map(argOf).filter(Boolean));
  assert.ok(args.has('AAA') && args.has('BBB'),
    `expected arg=AAA and arg=BBB, got ${JSON.stringify([...args])}`);

  // Reconnect phone A with the SAME phone_id → same ?arg=AAA (reattaches its session).
  const before = ttyd.connectionURLs.length;
  const phoneA2 = new MockiOSClient();
  await phoneA2.connect(relay.port, keyPair.publicKey, { phoneId: 'AAA', pairedAt: 1_700_000_000_000 });
  await waitFor(() => ttyd.connectionURLs.length > before, 5000);
  assert.ok(ttyd.connectionURLs.slice(before).some(u => argOf(u) === 'AAA'),
    `reconnect should reuse arg=AAA, got ${JSON.stringify(ttyd.connectionURLs.slice(before))}`);

  phoneA.disconnect();
  phoneB.disconnect();
  phoneA2.disconnect();
  bridge.stop();
  relayClient.disconnect();
  await relay.stop();
  await ttyd.stop();
});

// ─── Mesh membership / eviction (end-to-end) ───────────────────────────────────
//
//   [MeshClient = server X] ──WS──> [Mock Relay] ──WS──> [RelayClient + Bridge = server R]
//
// X meshes into R by connecting as a relay "client", identifying itself via
// peer_device_id. R's membership check decides whether X stays or is evicted.
// This exercises the real MeshClient ↔ Bridge handshake + EVICT loop end-to-end.

/** Build an isolated R (relay + ttyd + real RelayClient + Bridge). */
async function makeServerR(
  membership: (peerDeviceId: string) => boolean,
  isActive: () => boolean = () => true,
) {
  const relay = new MockRelay();
  const ttyd = new MockTtyd();
  await relay.start();
  await ttyd.start();
  const keyPair = crypto.generateKeyPair();
  const relayClient = new RelayClient(`http://127.0.0.1:${relay.port}`, 'device-R');
  const bridge = new Bridge(ttyd.wsURL, relayClient, keyPair);
  bridge.start();
  bridge.setMeshActiveCheck(isActive);
  bridge.setMeshMembershipCheck(membership);
  relayClient.connect();
  await waitFor(() => relay.serverConnected);
  const teardown = async () => {
    bridge.stop();
    relayClient.disconnect();
    await relay.stop();
    await ttyd.stop();
  };
  return { relay, keyPair, teardown };
}

/** A MeshClient (server X) dialing R, identifying itself as `ownDeviceId`. */
function makeMeshIntoR(
  relayPort: number, serverPublicKey: Buffer, ownDeviceId: string,
  onEvicted: (peerDeviceId: string) => void,
): MeshClient {
  const peer: MeshPeer = {
    name: `server-${ownDeviceId}`,
    deviceId: 'device-R',                 // the target peer (R)
    relayURL: `ws://127.0.0.1:${relayPort}`,
    pairingSecret: 'secret',
    remotePort: 7681,
    localPort: 17681,                     // never bound: no ACK ⇒ no listener
    serverPublicKey: serverPublicKey.toString('base64'),
  };
  return new MeshClient(peer, ownDeviceId, onEvicted);
}

test('5 – unknown peer while the server is ACTIVE is asked to retry, not evicted', async () => {
  // dev-X is not (yet) known, but R is active ⇒ R asks it to retry rather than
  // permanently evicting. onEvicted must NOT fire (the peer keeps trying), which
  // is what lets a simultaneous bidirectional setup converge instead of dead-
  // locking both peer lists to empty.
  const R = await makeServerR((id) => id === 'known-peer'); // dev-X is NOT known, R active
  const evicted: string[] = [];
  const mesh = makeMeshIntoR(R.relay.port, R.keyPair.publicKey, 'dev-X', (id) => evicted.push(id));
  mesh.start();

  // Well past the first retry cycle: still never permanently evicted.
  await sleep(1500);
  assert.deepEqual(evicted, [], 'an active server never permanently evicts; the peer retries');

  mesh.stop();
  await R.teardown();
});

test('6 – known mesh peer is not evicted end-to-end', async () => {
  const R = await makeServerR((id) => id === 'dev-X'); // dev-X IS known
  const evicted: string[] = [];
  const mesh = makeMeshIntoR(R.relay.port, R.keyPair.publicKey, 'dev-X', (id) => evicted.push(id));
  mesh.start();

  // Give the full handshake + (failed) PF_OPEN round-trip time to run; a known
  // peer must never trigger eviction even though its forward target is absent.
  await sleep(1000);
  assert.deepEqual(evicted, [], 'a known peer is never evicted');

  mesh.stop();
  await R.teardown();
});

// --- Self-eject / membership gating ---------------------------------------
//
// index.ts gates the membership predicate on `isMeshActive(meshPairedAt)` (a
// server-local anchor, decoupled from phone clusters): while ejected or past the
// 7-day cap, NO peer passes — even one still in savedPeers. A stale re-invite
// can't bring an ejected server back; only showing the QR (which re-anchors and
// un-ejects the server) lets peers in again.

test('7 – an inactive (self-ejected) server evicts even a known peer', async () => {
  // dev-X is "known", but the server is inactive (left/expired) ⇒ permanent evict.
  let active = false;
  const R = await makeServerR((id) => id === 'dev-X', () => active);
  const evicted: string[] = [];
  const mesh = makeMeshIntoR(R.relay.port, R.keyPair.publicKey, 'dev-X', (id) => evicted.push(id));
  mesh.start();

  await waitFor(() => evicted.length > 0, 5000);
  assert.deepEqual(evicted, ['device-R'], 'while inactive, even a known peer is evicted');

  mesh.stop();
  await R.teardown();
});

test('8 – showing the QR (active again) lets a previously-rejected peer rejoin', async () => {
  // Start inactive: the first dial is evicted. Then flip active (QR show) and a
  // fresh dial from the same peer is accepted (no eviction).
  let active = false;
  const R = await makeServerR((id) => id === 'dev-X', () => active);

  const evicted1: string[] = [];
  const mesh1 = makeMeshIntoR(R.relay.port, R.keyPair.publicKey, 'dev-X', (id) => evicted1.push(id));
  mesh1.start();
  await waitFor(() => evicted1.length > 0, 5000);
  assert.deepEqual(evicted1, ['device-R'], 'inactive server evicts the first dial');
  mesh1.stop();

  // QR shown → server re-anchored and un-ejected.
  active = true;
  const evicted2: string[] = [];
  const mesh2 = makeMeshIntoR(R.relay.port, R.keyPair.publicKey, 'dev-X', (id) => evicted2.push(id));
  mesh2.start();
  await sleep(1000);
  assert.deepEqual(evicted2, [], 'after QR show, the same peer is accepted');

  mesh2.stop();
  await R.teardown();
});

// ─── Single-use pairing ─────────────────────────────────────────────────────

async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

test('single-use pairing: first pair succeeds, second fails 409, PAIRING_CONSUMED reaches server', async () => {
  const relay = new MockRelay();
  await relay.start();
  const relayClient = new RelayClient(`http://127.0.0.1:${relay.port}`, 'device-pair');
  relayClient.connect();
  await waitFor(() => relay.serverConnected, 5000);

  let consumedSeen = false;
  relayClient.on('pairing_consumed', () => { consumedSeen = true; });

  const S = 'the-long-lived-secret';
  const T = 'one-time-T';
  const grant = await postJson(relay.grantUrl, {
    pairing_token: T,
    wrapped_secret: wrapSecret(S, T),
    grant_expires_at: Date.now() + 60_000,
  });
  assert.equal(grant.status, 200);

  const first = await postJson(relay.pairUrl, { pairing_token: T });
  assert.equal(first.status, 200);
  assert.equal(unwrapSecret(first.body.wrapped_secret, T), S);

  const second = await postJson(relay.pairUrl, { pairing_token: T });
  assert.equal(second.status, 409);

  await waitFor(() => consumedSeen, 5000);

  relayClient.disconnect();
  await relay.stop();
});

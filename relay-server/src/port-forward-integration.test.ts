import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import * as crypto from './crypto.js';
import { Bridge } from './bridge.js';
import { PF_OPEN, PF_DATA, PF_CLOSE, PF_OPEN_ACK } from './port-forward.js';

// ── Constants matching bridge.ts ────────────────────────────────────────────
const MSG_HANDSHAKE = 0x01;
const MSG_HANDSHAKE_ACK = 0x02;
const MSG_DATA = 0x03;

// ── Fake RelayClient ────────────────────────────────────────────────────────

/** Minimal mock that satisfies Bridge's relay dependency. The Bridge keys
 *  per-client sessions by connId: it expects a client_connect event before any
 *  message, three-arg message events, and sends with (type, connId, payload).
 *  All tests here use a single client, connId 1. */
class FakeRelay extends EventEmitter {
  sent: { type: number; connId: number; payload: Buffer }[] = [];

  send(type: number, connId: number, payload: Buffer): void {
    this.sent.push({ type, connId, payload });
  }

  clear(): void {
    this.sent = [];
  }

  /** Simulate the mobile client connecting through the relay */
  injectClientConnect(connId = 1): void {
    this.emit('client_connect', connId, Buffer.alloc(0));
  }

  /** Simulate an incoming message from the mobile client via the relay */
  injectMessage(type: number, payload: Buffer, connId = 1): void {
    this.emit('message', type, connId, payload);
  }

  /** Simulate client going offline */
  injectClientOffline(connId = 1): void {
    this.emit('client_offline', connId);
  }

  /** Get sent messages of a given type, decrypting DATA payloads with the provided key */
  decryptedData(key: Buffer): { raw: Buffer; subCmd?: number; flowId?: number; payload?: Buffer }[] {
    return this.sent
      .filter(m => m.type === MSG_DATA)
      .map(m => {
        const raw = crypto.decrypt(m.payload, key);
        if (raw.length >= 5 && raw[0] >= 0x40 && raw[0] <= 0x43) {
          return { raw, subCmd: raw[0], flowId: raw.readUInt32BE(1), payload: raw.subarray(5) };
        }
        return { raw };
      });
  }

  waitForSent(n: number, ms = 3000): Promise<void> {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.sent.length >= n) return resolve();
        if (Date.now() - t0 > ms) return reject(new Error(`Timeout: wanted ${n} sent, got ${this.sent.length}`));
        setTimeout(check, 20);
      };
      check();
    });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Start a minimal WebSocket server to stand in for local ttyd */
async function fakeTtydServer(): Promise<{ port: number; wss: WebSocketServer; close: () => Promise<void> }> {
  return new Promise(resolve => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('listening', () => {
      const port = (wss.address() as net.AddressInfo).port;
      resolve({
        port,
        wss,
        close: () => new Promise<void>(r => {
          for (const ws of wss.clients) ws.terminate();
          wss.close(() => r());
        }),
      });
    });
  });
}

/** TCP echo server */
async function echoServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const conns: net.Socket[] = [];
  return new Promise(resolve => {
    const srv = net.createServer(s => {
      s.on('error', () => {});
      conns.push(s);
      s.on('data', d => s.write(d));
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      resolve({
        port,
        close: () => {
          for (const c of conns) c.destroy();
          return new Promise<void>(r => srv.close(() => r()));
        },
      });
    });
  });
}

/** TCP server that responds and closes */
async function responseServer(resp: string): Promise<{ port: number; received: Buffer[]; close: () => Promise<void> }> {
  const conns: net.Socket[] = [];
  const received: Buffer[] = [];
  return new Promise(resolve => {
    const srv = net.createServer(s => {
      s.on('error', () => {});
      conns.push(s);
      s.on('data', d => { received.push(d); s.write(resp); s.end(); });
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      resolve({
        port,
        received,
        close: () => {
          for (const c of conns) c.destroy();
          return new Promise<void>(r => srv.close(() => r()));
        },
      });
    });
  });
}

async function unusedPort(): Promise<number> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Perform key exchange with the Bridge via the fake relay, return the derived symmetric key */
function performHandshake(relay: FakeRelay, serverPubKey: Buffer): Buffer {
  // The relay always announces a client before its messages; the Bridge creates
  // the per-client session on this event and drops messages for unknown connIds.
  relay.injectClientConnect();
  const clientKP = crypto.generateKeyPair();
  const payload = Buffer.from(JSON.stringify({ client_public_key: clientKP.publicKey.toString('base64') }));
  relay.injectMessage(MSG_HANDSHAKE, payload);

  const sharedSecret = crypto.computeSharedSecret(clientKP.privateKey, serverPubKey);
  return crypto.deriveKey(sharedSecret);
}

/** Encrypt a port-forward sub-message and inject it as MSG_DATA */
function sendEncryptedPF(relay: FakeRelay, key: Buffer, subCmd: number, flowId: number, payload: Buffer): void {
  const header = Buffer.alloc(5);
  header[0] = subCmd;
  header.writeUInt32BE(flowId, 1);
  const pfMsg = Buffer.concat([header, payload]);
  const encrypted = crypto.encrypt(pfMsg, key);
  relay.injectMessage(MSG_DATA, encrypted);
}

function openPayload(remotePort: number, localPort: number): Buffer {
  return Buffer.from(JSON.stringify({ remotePort, localPort }));
}

function firstDataPayload(remotePort: number, data: Buffer): Buffer {
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(remotePort, 0);
  return Buffer.concat([prefix, data]);
}

// ── Integration Tests ───────────────────────────────────────────────────────

test('integration: PF_OPEN through Bridge produces encrypted ACK', async () => {
  const ttyd = await fakeTtydServer();
  const relay = new FakeRelay();
  const serverKP = crypto.generateKeyPair();
  const bridge = new Bridge(`ws://127.0.0.1:${ttyd.port}`, relay as any, serverKP);

  bridge.start();
  await sleep(200); // let local WS connect

  const symKey = performHandshake(relay, serverKP.publicKey);
  await sleep(100);
  relay.clear();

  const echo = await echoServer();
  try {
    sendEncryptedPF(relay, symKey, PF_OPEN, 0, openPayload(echo.port, 9999));
    await relay.waitForSent(1);

    const msgs = relay.decryptedData(symKey);
    const ack = msgs.find(m => m.subCmd === PF_OPEN_ACK);
    assert.ok(ack, 'should receive PF_OPEN_ACK');
    const parsed = JSON.parse(ack!.payload!.toString());
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.remotePort, echo.port);
  } finally {
    bridge.stop();
    await echo.close();
    await ttyd.close();
  }
});

test('integration: PF_OPEN ACK error for unreachable port', async () => {
  const ttyd = await fakeTtydServer();
  const relay = new FakeRelay();
  const serverKP = crypto.generateKeyPair();
  const bridge = new Bridge(`ws://127.0.0.1:${ttyd.port}`, relay as any, serverKP);

  bridge.start();
  await sleep(200);

  const symKey = performHandshake(relay, serverKP.publicKey);
  await sleep(100);
  relay.clear();

  const port = await unusedPort();
  try {
    sendEncryptedPF(relay, symKey, PF_OPEN, 0, openPayload(port, 9999));
    await relay.waitForSent(1);

    const msgs = relay.decryptedData(symKey);
    const ack = msgs.find(m => m.subCmd === PF_OPEN_ACK);
    assert.ok(ack, 'should receive PF_OPEN_ACK');
    const parsed = JSON.parse(ack!.payload!.toString());
    assert.equal(parsed.status, 'error');
    assert.ok(parsed.message);
  } finally {
    bridge.stop();
    await ttyd.close();
  }
});

test('integration: encrypted PF_DATA round-trip through Bridge', async () => {
  const ttyd = await fakeTtydServer();
  const relay = new FakeRelay();
  const serverKP = crypto.generateKeyPair();
  const bridge = new Bridge(`ws://127.0.0.1:${ttyd.port}`, relay as any, serverKP);

  bridge.start();
  await sleep(200);

  const symKey = performHandshake(relay, serverKP.publicKey);
  await sleep(100);

  const echo = await echoServer();
  try {
    // Register port
    relay.clear();
    sendEncryptedPF(relay, symKey, PF_OPEN, 0, openPayload(echo.port, 9999));
    await relay.waitForSent(1);
    relay.clear();

    // Send data through flow
    sendEncryptedPF(relay, symKey, PF_DATA, 1, firstDataPayload(echo.port, Buffer.from('ping')));
    await relay.waitForSent(1);

    const data = relay.decryptedData(symKey).filter(m => m.subCmd === PF_DATA);
    assert.ok(data.length >= 1, 'should echo data back');
    assert.equal(data[0].flowId, 1);
    assert.deepEqual(data[0].payload, Buffer.from('ping'));
  } finally {
    bridge.stop();
    await echo.close();
    await ttyd.close();
  }
});

test('integration: terminal data not routed to port-forward handler', async () => {
  const ttyd = await fakeTtydServer();
  const relay = new FakeRelay();
  const serverKP = crypto.generateKeyPair();
  const bridge = new Bridge(`ws://127.0.0.1:${ttyd.port}`, relay as any, serverKP);

  bridge.start();
  await sleep(200);

  const symKey = performHandshake(relay, serverKP.publicKey);
  await sleep(200); // allow reconnect
  relay.clear();

  try {
    // Send normal terminal data (first byte < 0x40) — should be forwarded to ttyd, not port-forward
    const termData = Buffer.from([0x01, 0x68, 0x69]); // type=input, "hi"
    const encrypted = crypto.encrypt(termData, symKey);
    relay.injectMessage(MSG_DATA, encrypted);

    await sleep(200);

    // No port-forward responses expected — only terminal data relay
    const pfMsgs = relay.decryptedData(symKey).filter(m => m.subCmd !== undefined);
    assert.equal(pfMsgs.length, 0, 'terminal data should not trigger PF responses');
  } finally {
    bridge.stop();
    await ttyd.close();
  }
});

test('integration: client_offline destroys port-forward state', async () => {
  const ttyd = await fakeTtydServer();
  const relay = new FakeRelay();
  const serverKP = crypto.generateKeyPair();
  const bridge = new Bridge(`ws://127.0.0.1:${ttyd.port}`, relay as any, serverKP);

  bridge.start();
  await sleep(200);

  const symKey = performHandshake(relay, serverKP.publicKey);
  await sleep(100);

  const echo = await echoServer();
  try {
    // Register port and open flow
    relay.clear();
    sendEncryptedPF(relay, symKey, PF_OPEN, 0, openPayload(echo.port, 9999));
    await relay.waitForSent(1);
    relay.clear();

    sendEncryptedPF(relay, symKey, PF_DATA, 1, firstDataPayload(echo.port, Buffer.from('hi')));
    await relay.waitForSent(1);
    relay.clear();

    // Client goes offline
    relay.injectClientOffline();
    await sleep(100);

    // New handshake (new client session)
    const symKey2 = performHandshake(relay, serverKP.publicKey);
    await sleep(100);
    relay.clear();

    // Old port registration should be gone — data to old port should be rejected
    sendEncryptedPF(relay, symKey2, PF_DATA, 2, firstDataPayload(echo.port, Buffer.from('old')));
    await relay.waitForSent(1);

    const closes = relay.decryptedData(symKey2).filter(m => m.subCmd === PF_CLOSE);
    assert.ok(closes.length >= 1, 'old port registration should be gone after client_offline + re-handshake');
  } finally {
    bridge.stop();
    await echo.close();
    await ttyd.close();
  }
});

test('integration: new handshake resets port-forward handler', async () => {
  const ttyd = await fakeTtydServer();
  const relay = new FakeRelay();
  const serverKP = crypto.generateKeyPair();
  const bridge = new Bridge(`ws://127.0.0.1:${ttyd.port}`, relay as any, serverKP);

  bridge.start();
  await sleep(200);

  const echo = await echoServer();
  try {
    // First session
    const symKey1 = performHandshake(relay, serverKP.publicKey);
    await sleep(100);
    relay.clear();

    sendEncryptedPF(relay, symKey1, PF_OPEN, 0, openPayload(echo.port, 9999));
    await relay.waitForSent(1);
    relay.clear();

    // Second handshake (new client) — old state should be destroyed
    const symKey2 = performHandshake(relay, serverKP.publicKey);
    await sleep(100);
    relay.clear();

    // Port should not be registered in new handler
    sendEncryptedPF(relay, symKey2, PF_DATA, 10, firstDataPayload(echo.port, Buffer.from('x')));
    await relay.waitForSent(1);

    const closes = relay.decryptedData(symKey2).filter(m => m.subCmd === PF_CLOSE);
    assert.ok(closes.length >= 1, 'port registration from old session should not carry over');
  } finally {
    bridge.stop();
    await echo.close();
    await ttyd.close();
  }
});

test('integration: PF_CLOSE through Bridge tears down TCP socket', async () => {
  const ttyd = await fakeTtydServer();
  const relay = new FakeRelay();
  const serverKP = crypto.generateKeyPair();
  const bridge = new Bridge(`ws://127.0.0.1:${ttyd.port}`, relay as any, serverKP);

  bridge.start();
  await sleep(200);

  const symKey = performHandshake(relay, serverKP.publicKey);
  await sleep(100);

  const echo = await echoServer();
  try {
    relay.clear();
    sendEncryptedPF(relay, symKey, PF_OPEN, 0, openPayload(echo.port, 9999));
    await relay.waitForSent(1);
    relay.clear();

    // Open flow
    sendEncryptedPF(relay, symKey, PF_DATA, 5, firstDataPayload(echo.port, Buffer.from('hello')));
    await relay.waitForSent(1);
    relay.clear();

    // Close flow
    sendEncryptedPF(relay, symKey, PF_CLOSE, 5, Buffer.alloc(0));
    await sleep(200);
    relay.clear();

    // Subsequent data on same flowId should be treated as zombie
    sendEncryptedPF(relay, symKey, PF_DATA, 5, Buffer.from('zombie'));
    await relay.waitForSent(1);

    const closes = relay.decryptedData(symKey).filter(m => m.subCmd === PF_CLOSE);
    assert.ok(closes.length >= 1, 'zombie data should get PF_CLOSE back');
  } finally {
    bridge.stop();
    await echo.close();
    await ttyd.close();
  }
});

test('integration: server-initiated close propagates as encrypted PF_CLOSE', async () => {
  const ttyd = await fakeTtydServer();
  const relay = new FakeRelay();
  const serverKP = crypto.generateKeyPair();
  const bridge = new Bridge(`ws://127.0.0.1:${ttyd.port}`, relay as any, serverKP);

  bridge.start();
  await sleep(200);

  const symKey = performHandshake(relay, serverKP.publicKey);
  await sleep(100);

  const srv = await responseServer('goodbye');
  try {
    relay.clear();
    sendEncryptedPF(relay, symKey, PF_OPEN, 0, openPayload(srv.port, 9999));
    await relay.waitForSent(1);
    relay.clear();

    sendEncryptedPF(relay, symKey, PF_DATA, 7, firstDataPayload(srv.port, Buffer.from('request')));
    await sleep(500);

    const msgs = relay.decryptedData(symKey);
    const data = msgs.filter(m => m.subCmd === PF_DATA && m.flowId === 7);
    assert.ok(data.length >= 1, 'should receive response data');
    assert.ok(Buffer.concat(data.map(m => m.payload!)).toString().includes('goodbye'));

    const closes = msgs.filter(m => m.subCmd === PF_CLOSE && m.flowId === 7);
    assert.ok(closes.length >= 1, 'should receive PF_CLOSE when server hangs up');
  } finally {
    bridge.stop();
    await srv.close();
    await ttyd.close();
  }
});

test('integration: multiple concurrent flows through Bridge', async () => {
  const ttyd = await fakeTtydServer();
  const relay = new FakeRelay();
  const serverKP = crypto.generateKeyPair();
  const bridge = new Bridge(`ws://127.0.0.1:${ttyd.port}`, relay as any, serverKP);

  bridge.start();
  await sleep(200);

  const symKey = performHandshake(relay, serverKP.publicKey);
  await sleep(100);

  const echo = await echoServer();
  try {
    relay.clear();
    sendEncryptedPF(relay, symKey, PF_OPEN, 0, openPayload(echo.port, 9999));
    await relay.waitForSent(1);
    relay.clear();

    // Open 3 concurrent flows
    for (const id of [10, 11, 12]) {
      sendEncryptedPF(relay, symKey, PF_DATA, id, firstDataPayload(echo.port, Buffer.from(`msg${id}`)));
    }
    await relay.waitForSent(3);

    const data = relay.decryptedData(symKey).filter(m => m.subCmd === PF_DATA);
    for (const id of [10, 11, 12]) {
      const msg = data.find(m => m.flowId === id);
      assert.ok(msg, `flow ${id} should echo back`);
      assert.ok(msg!.payload!.toString().includes(`msg${id}`));
    }
  } finally {
    bridge.stop();
    await echo.close();
    await ttyd.close();
  }
});

test('integration: decryption with wrong key is rejected (no crash)', async () => {
  const ttyd = await fakeTtydServer();
  const relay = new FakeRelay();
  const serverKP = crypto.generateKeyPair();
  const bridge = new Bridge(`ws://127.0.0.1:${ttyd.port}`, relay as any, serverKP);

  bridge.start();
  await sleep(200);

  const symKey = performHandshake(relay, serverKP.publicKey);
  await sleep(100);
  relay.clear();

  try {
    // Encrypt with a random wrong key
    const wrongKey = crypto.deriveKey(Buffer.alloc(32, 0xAB));
    const header = Buffer.alloc(5);
    header[0] = PF_OPEN;
    header.writeUInt32BE(0, 1);
    const pfMsg = Buffer.concat([header, openPayload(12345, 9999)]);
    const badEncrypted = crypto.encrypt(pfMsg, wrongKey);

    relay.injectMessage(MSG_DATA, badEncrypted);
    await sleep(200);

    // Bridge should not crash and no messages sent
    assert.equal(relay.sent.length, 0, 'bad encryption should be silently dropped');
  } finally {
    bridge.stop();
    await ttyd.close();
  }
});

test('integration: Bridge.stop cleans up port-forward handler', async () => {
  const ttyd = await fakeTtydServer();
  const relay = new FakeRelay();
  const serverKP = crypto.generateKeyPair();
  const bridge = new Bridge(`ws://127.0.0.1:${ttyd.port}`, relay as any, serverKP);

  bridge.start();
  await sleep(200);

  const symKey = performHandshake(relay, serverKP.publicKey);
  await sleep(100);

  const echo = await echoServer();
  try {
    relay.clear();
    sendEncryptedPF(relay, symKey, PF_OPEN, 0, openPayload(echo.port, 9999));
    await relay.waitForSent(1);
    relay.clear();

    sendEncryptedPF(relay, symKey, PF_DATA, 1, firstDataPayload(echo.port, Buffer.from('x')));
    await relay.waitForSent(1);
    relay.clear();

    // Stop should not throw even with active flows
    bridge.stop();
    await sleep(100);

    // After stop, injecting messages should be harmless (no listeners)
    relay.injectMessage(MSG_DATA, crypto.encrypt(Buffer.from([PF_OPEN, 0, 0, 0, 0]), symKey));
    await sleep(100);
    assert.equal(relay.sent.length, 0, 'no messages after stop');
  } finally {
    await echo.close();
    await ttyd.close();
  }
});

test('integration: two ports forwarded over one connection', async () => {
  const ttyd = await fakeTtydServer();
  const relay = new FakeRelay();
  const serverKP = crypto.generateKeyPair();
  const bridge = new Bridge(`ws://127.0.0.1:${ttyd.port}`, relay as any, serverKP);

  bridge.start();
  await sleep(200);

  const symKey = performHandshake(relay, serverKP.publicKey);
  await sleep(100);

  const echo1 = await echoServer();
  const echo2 = await echoServer();
  try {
    // Register both ports over the same connection.
    relay.clear();
    sendEncryptedPF(relay, symKey, PF_OPEN, 0, openPayload(echo1.port, 9991));
    sendEncryptedPF(relay, symKey, PF_OPEN, 0, openPayload(echo2.port, 9992));
    await relay.waitForSent(2); // two ACKs
    const acks = relay.decryptedData(symKey).filter(m => m.subCmd === PF_OPEN_ACK)
      .map(m => JSON.parse(m.payload!.toString()));
    assert.equal(acks.length, 2);
    assert.ok(acks.every(a => a.status === 'ok'));
    assert.deepEqual(new Set(acks.map(a => a.remotePort)), new Set([echo1.port, echo2.port]));
    relay.clear();

    // One flow to each port, routed by the first-packet prefix.
    sendEncryptedPF(relay, symKey, PF_DATA, 21, firstDataPayload(echo1.port, Buffer.from('to-one')));
    sendEncryptedPF(relay, symKey, PF_DATA, 22, firstDataPayload(echo2.port, Buffer.from('to-two')));
    await relay.waitForSent(2);

    const data = relay.decryptedData(symKey).filter(m => m.subCmd === PF_DATA);
    const flow21 = data.find(m => m.flowId === 21);
    const flow22 = data.find(m => m.flowId === 22);
    assert.ok(flow21 && flow21.payload!.toString().includes('to-one'), 'flow 21 echoes via port 1');
    assert.ok(flow22 && flow22.payload!.toString().includes('to-two'), 'flow 22 echoes via port 2');
  } finally {
    bridge.stop();
    await echo1.close();
    await echo2.close();
    await ttyd.close();
  }
});

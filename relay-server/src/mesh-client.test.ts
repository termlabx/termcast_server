import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as http from 'node:http';
import * as WS from 'ws';
import { MeshClient, type MeshPeer } from './mesh-client.js';
import * as crypto from './crypto.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const MSG_HANDSHAKE = 0x01;
const MSG_HANDSHAKE_ACK = 0x02;
const MSG_DATA = 0x03;
const PF_OPEN = 0x40;
const PF_DATA = 0x41;
const PF_CLOSE = 0x42;
const PF_OPEN_ACK = 0x43;

function send(ws: WS.WebSocket, type: number, payload: Buffer) {
  const msg = Buffer.alloc(1 + payload.length);
  msg[0] = type;
  payload.copy(msg, 1);
  ws.send(msg);
}

function frameInner(subCmd: number, flowId: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(5);
  h[0] = subCmd;
  h.writeUInt32BE(flowId, 1);
  return Buffer.concat([h, payload]);
}

function sendEncrypted(ws: WS.WebSocket, key: Buffer, inner: Buffer) {
  const encrypted = crypto.encrypt(inner, key);
  send(ws, MSG_DATA, encrypted);
}

/** Spin up a mock relay that acts as server2's bridge (server side). */
async function mockRelay(
  serverKP: { publicKey: Buffer; privateKey: Buffer },
  opts: { ackError?: (remotePort: number) => string | undefined } = {},
): Promise<{
  url: string;
  close: () => void;
  /** Resolves with first decrypted PF_OPEN the relay received */
  waitForPFOpen: () => Promise<{ remotePort: number; localPort: number }>;
  /** Resolves once n PF_OPENs have arrived, with all of them */
  waitForPFOpens: (n: number) => Promise<{ remotePort: number; localPort: number }[]>;
  /** Resolves with first decrypted PF_DATA payload for given flowId */
  waitForPFData: (flowId: number) => Promise<Buffer>;
  /** Send PF_DATA back to MeshClient */
  sendPFData: (flowId: number, data: Buffer) => void;
}> {
  let symKey: Buffer | null = null;
  let serverWs: WS.WebSocket | null = null;
  const pfOpenResolvers: Array<(v: { remotePort: number; localPort: number }) => void> = [];
  const pfOpens: { remotePort: number; localPort: number }[] = [];
  const pfDataResolvers = new Map<number, Array<(v: Buffer) => void>>();

  const wss = new WS.WebSocketServer({ port: 0 });

  wss.on('connection', (ws) => {
    serverWs = ws;
    ws.on('message', (raw: Buffer) => {
      const type = raw[0];
      const payload = raw.subarray(1);

      if (type === MSG_HANDSHAKE) {
        const { client_public_key } = JSON.parse(payload.toString());
        const clientPub = Buffer.from(client_public_key, 'base64');
        const secret = crypto.computeSharedSecret(serverKP.privateKey, clientPub);
        symKey = crypto.deriveKey(secret);
        // Send HANDSHAKE_ACK (just status ok, payload ignored by client)
        send(ws, MSG_HANDSHAKE_ACK, Buffer.from(JSON.stringify({ status: 'ok' })));
      } else if (type === MSG_DATA && symKey) {
        const inner = crypto.decrypt(payload, symKey);
        const subCmd = inner[0];
        const flowId = inner.readUInt32BE(1);
        const rest = inner.subarray(5);

        if (subCmd === PF_OPEN) {
          const parsed = JSON.parse(rest.toString());
          pfOpens.push(parsed);
          const errMsg = opts.ackError?.(parsed.remotePort);
          const ackBody = errMsg
            ? { remotePort: parsed.remotePort, status: 'error', message: errMsg }
            : { remotePort: parsed.remotePort, status: 'ok' };
          const ack = frameInner(PF_OPEN_ACK, 0, Buffer.from(JSON.stringify(ackBody)));
          sendEncrypted(ws, symKey!, ack);
          pfOpenResolvers.splice(0).forEach(r => r(parsed));
        } else if (subCmd === PF_DATA) {
          const resolvers = pfDataResolvers.get(flowId) ?? [];
          resolvers.splice(0).forEach(r => r(rest));
        }
      }
    });
  });

  const port: number = await new Promise(r => wss.on('listening', () => r((wss.address() as net.AddressInfo).port)));

  return {
    url: `ws://127.0.0.1:${port}`,
    close: () => wss.close(),
    waitForPFOpen: () => new Promise(r => pfOpenResolvers.push(r)),
    waitForPFOpens: async (n) => {
      const t0 = Date.now();
      while (pfOpens.length < n) {
        if (Date.now() - t0 > 3000) throw new Error(`waitForPFOpens timeout: wanted ${n}, got ${pfOpens.length}`);
        await new Promise(r => setTimeout(r, 20));
      }
      return pfOpens;
    },
    waitForPFData: (flowId) => new Promise(r => {
      if (!pfDataResolvers.has(flowId)) pfDataResolvers.set(flowId, []);
      pfDataResolvers.get(flowId)!.push(r);
    }),
    sendPFData: (flowId, data) => {
      if (!serverWs || !symKey) return;
      sendEncrypted(serverWs, symKey, frameInner(PF_DATA, flowId, data));
    },
  };
}

async function waitFor<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
  const t0 = Date.now();
  while (true) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise(r => setTimeout(r, 20));
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('MeshClient: sends PF_OPEN after handshake and starts TCP server', async () => {
  const serverKP = crypto.generateKeyPair();
  const relay = await mockRelay(serverKP);

  const peer: MeshPeer = {
    name: 'test-peer',
    deviceId: 'dev-1',
    relayURL: relay.url,
    pairingSecret: 'secret',
    remotePort: 7681,
    localPort: 0, // will be overridden in test
    serverPublicKey: serverKP.publicKey.toString('base64'),
  };
  // Use a random available port
  const testPort: number = await new Promise(r => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      r((s.address() as net.AddressInfo).port);
      s.close();
    });
  });
  peer.localPort = testPort;

  const client = new MeshClient(peer);
  after(() => client.stop());
  after(() => relay.close());

  client.start();

  // Wait for PF_OPEN to arrive at mock relay
  const pfOpen = await relay.waitForPFOpen();
  assert.equal(pfOpen.remotePort, 7681);
  assert.equal(pfOpen.localPort, testPort);

  // TCP server should now be listening
  await waitFor(() => {
    const s = net.createConnection({ host: '127.0.0.1', port: testPort });
    s.destroy();
    return true;
  });
});

test('MeshClient: proxies TCP data to peer via PF_DATA', async () => {
  const serverKP = crypto.generateKeyPair();
  const relay = await mockRelay(serverKP);

  const testPort: number = await new Promise(r => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      r((s.address() as net.AddressInfo).port);
      s.close();
    });
  });

  const peer: MeshPeer = {
    name: 'test-peer2',
    deviceId: 'dev-2',
    relayURL: relay.url,
    pairingSecret: 'secret',
    remotePort: 7681,
    localPort: testPort,
    serverPublicKey: serverKP.publicKey.toString('base64'),
  };

  const client = new MeshClient(peer);
  after(() => client.stop());
  after(() => relay.close());

  client.start();
  await relay.waitForPFOpen(); // await handshake + PF_OPEN

  // Give TCP server time to start
  await new Promise(r => setTimeout(r, 100));

  // Connect to the TCP server and send data
  const tcpClient = net.createConnection({ host: '127.0.0.1', port: testPort });
  await new Promise(r => tcpClient.once('connect', r));
  tcpClient.write(Buffer.from('hello'));

  // First PF_DATA has 2-byte remotePort prefix (7681 = 0x1dc1) + data
  const pfData = await relay.waitForPFData(1);
  const remotePort = pfData.readUInt16BE(0);
  assert.equal(remotePort, 7681);
  assert.deepEqual(pfData.subarray(2), Buffer.from('hello'));

  tcpClient.destroy();
});

test('MeshClient: keeps retrying after repeated HTTP 4xx (does not give up)', async () => {
  // A server that rejects every WebSocket upgrade with 403, counting attempts.
  let attempts = 0;
  const srv = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
  srv.on('upgrade', (_req, socket) => {
    attempts++;
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
  });
  const port: number = await new Promise(r =>
    srv.listen(0, '127.0.0.1', () => r((srv.address() as net.AddressInfo).port)));

  const peer: MeshPeer = {
    name: 'reject-peer',
    deviceId: 'dev-reject',
    relayURL: `ws://127.0.0.1:${port}`,
    pairingSecret: 'secret',
    remotePort: 7681,
    localPort: 0,
    serverPublicKey: crypto.generateKeyPair().publicKey.toString('base64'),
  };

  const client = new MeshClient(peer);
  after(() => client.stop());
  after(() => srv.close());

  client.start();

  // Old behavior gave up permanently after exactly 2 rejections.
  // New behavior must keep retrying — assert a 3rd attempt eventually happens.
  await waitFor(() => (attempts >= 3 ? attempts : undefined), 8000);
  assert.ok(attempts >= 3, `expected >= 3 connection attempts, got ${attempts}`);
});

test('MeshClient: delivers relay PF_DATA to TCP client', async () => {
  const serverKP = crypto.generateKeyPair();
  const relay = await mockRelay(serverKP);

  const testPort: number = await new Promise(r => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      r((s.address() as net.AddressInfo).port);
      s.close();
    });
  });

  const peer: MeshPeer = {
    name: 'test-peer3',
    deviceId: 'dev-3',
    relayURL: relay.url,
    pairingSecret: 'secret',
    remotePort: 7681,
    localPort: testPort,
    serverPublicKey: serverKP.publicKey.toString('base64'),
  };

  const client = new MeshClient(peer);
  after(() => client.stop());
  after(() => relay.close());

  client.start();
  await relay.waitForPFOpen();
  await new Promise(r => setTimeout(r, 100));

  // Connect TCP client and record received data
  const received: Buffer[] = [];
  const tcpClient = net.createConnection({ host: '127.0.0.1', port: testPort });
  tcpClient.on('data', (d: Buffer) => received.push(d));
  await new Promise(r => tcpClient.once('connect', r));

  // Trigger a flow by sending something first (creates flowId=1 on MeshClient)
  tcpClient.write(Buffer.from('ping'));
  await relay.waitForPFData(1); // wait for PF_DATA from client

  // Send PF_DATA back from relay (flowId=1, no prefix needed for return path)
  relay.sendPFData(1, Buffer.from('pong'));

  await waitFor(() => received.length > 0 ? received : undefined);
  assert.deepEqual(Buffer.concat(received), Buffer.from('pong'));

  tcpClient.destroy();
});

function freePort(): Promise<number> {
  return new Promise(r => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      r((s.address() as net.AddressInfo).port);
      s.close();
    });
  });
}

test('MeshClient: opens one PF_OPEN and one listener per configured forward', async () => {
  const serverKP = crypto.generateKeyPair();
  const relay = await mockRelay(serverKP);

  const ttydLocal = await freePort();
  const fwdALocal = await freePort();
  const fwdBLocal = await freePort();

  const peer: MeshPeer = {
    name: 'multi-peer',
    deviceId: 'dev-multi',
    relayURL: relay.url,
    pairingSecret: 'secret',
    remotePort: 7681,
    localPort: ttydLocal,
    serverPublicKey: serverKP.publicKey.toString('base64'),
    forwards: [
      { remotePort: 3100, localPort: fwdALocal, source: 'local' },
      { remotePort: 3200, localPort: fwdBLocal, source: 'invite' },
    ],
  };

  const client = new MeshClient(peer);
  after(() => client.stop());
  after(() => relay.close());

  client.start();

  const opens = await relay.waitForPFOpens(3);
  const byRemote = new Map(opens.map(o => [o.remotePort, o.localPort]));
  assert.equal(byRemote.get(7681), ttydLocal);
  assert.equal(byRemote.get(3100), fwdALocal);
  assert.equal(byRemote.get(3200), fwdBLocal);

  await new Promise(r => setTimeout(r, 100)); // listeners come up

  // Data into the 3100 listener carries a 3100 prefix (flowId 1)…
  const sockA = net.createConnection({ host: '127.0.0.1', port: fwdALocal });
  await new Promise(r => sockA.once('connect', r));
  sockA.write(Buffer.from('aaa'));
  const dataA = await relay.waitForPFData(1);
  assert.equal(dataA.readUInt16BE(0), 3100);
  assert.deepEqual(dataA.subarray(2), Buffer.from('aaa'));

  // …and data into the 3200 listener carries a 3200 prefix (flowId 2).
  const sockB = net.createConnection({ host: '127.0.0.1', port: fwdBLocal });
  await new Promise(r => sockB.once('connect', r));
  sockB.write(Buffer.from('bbb'));
  const dataB = await relay.waitForPFData(2);
  assert.equal(dataB.readUInt16BE(0), 3200);
  assert.deepEqual(dataB.subarray(2), Buffer.from('bbb'));

  sockA.destroy();
  sockB.destroy();
});

test('MeshClient: a rejected forward goes to error state without affecting others', async () => {
  const serverKP = crypto.generateKeyPair();
  const relay = await mockRelay(serverKP, {
    ackError: (remotePort) => (remotePort === 3100 ? 'connection refused' : undefined),
  });

  const ttydLocal = await freePort();
  const fwdALocal = await freePort();
  const fwdBLocal = await freePort();

  const peer: MeshPeer = {
    name: 'partial-peer',
    deviceId: 'dev-partial',
    relayURL: relay.url,
    pairingSecret: 'secret',
    remotePort: 7681,
    localPort: ttydLocal,
    serverPublicKey: serverKP.publicKey.toString('base64'),
    forwards: [
      { remotePort: 3100, localPort: fwdALocal, source: 'local' },
      { remotePort: 3200, localPort: fwdBLocal, source: 'local' },
    ],
  };

  const client = new MeshClient(peer);
  after(() => client.stop());
  after(() => relay.close());

  client.start();
  await relay.waitForPFOpens(3);

  const states = await waitFor(() => {
    const s = client.forwardStates();
    const a = s.find(f => f.remotePort === 3100);
    const b = s.find(f => f.remotePort === 3200);
    return a?.state === 'error' && b?.state === 'active' ? s : undefined;
  });

  const failed = states.find(f => f.remotePort === 3100)!;
  assert.equal(failed.state, 'error');
  assert.equal(failed.message, 'connection refused');
  assert.equal(states.find(f => f.remotePort === 3200)!.state, 'active');

  // The healthy forward still proxies.
  const sockB = net.createConnection({ host: '127.0.0.1', port: fwdBLocal });
  await new Promise(r => sockB.once('connect', r));
  sockB.write(Buffer.from('ok'));
  const dataB = await relay.waitForPFData(1);
  assert.equal(dataB.readUInt16BE(0), 3200);
  sockB.destroy();
});

test('MeshClient: EADDRINUSE on a forward listener becomes error state', async () => {
  const serverKP = crypto.generateKeyPair();
  const relay = await mockRelay(serverKP);

  const ttydLocal = await freePort();
  // Occupy a port so the forward listener cannot bind it.
  const blocker = net.createServer().listen(0, '127.0.0.1');
  await new Promise(r => blocker.once('listening', r));
  const blockedPort = (blocker.address() as net.AddressInfo).port;
  after(() => blocker.close());

  const peer: MeshPeer = {
    name: 'clash-peer',
    deviceId: 'dev-clash',
    relayURL: relay.url,
    pairingSecret: 'secret',
    remotePort: 7681,
    localPort: ttydLocal,
    serverPublicKey: serverKP.publicKey.toString('base64'),
    forwards: [{ remotePort: 3300, localPort: blockedPort, source: 'local' }],
  };

  const client = new MeshClient(peer);
  after(() => client.stop());
  after(() => relay.close());

  client.start();
  await relay.waitForPFOpens(2);

  const states = await waitFor(() => {
    const s = client.forwardStates();
    return s.find(f => f.remotePort === 3300)?.state === 'error' ? s : undefined;
  });
  assert.match(states.find(f => f.remotePort === 3300)!.message ?? '', /EADDRINUSE|address|in use/i);
});

const MESH_EVICT = 0x50;
const MESH_RETRY = 0x52;

test('MeshClient: handshake carries own deviceId as peer_device_id', async () => {
  const serverKP = crypto.generateKeyPair();
  let handshakeJson: any = null;
  const wss = new WS.WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => {
    ws.on('message', (raw: Buffer) => {
      if (raw[0] === MSG_HANDSHAKE) handshakeJson = JSON.parse(raw.subarray(1).toString());
    });
  });
  const port: number = await new Promise(r =>
    wss.on('listening', () => r((wss.address() as net.AddressInfo).port)));

  const peer: MeshPeer = {
    name: 'p', deviceId: 'dev-R', relayURL: `ws://127.0.0.1:${port}`,
    pairingSecret: 's', remotePort: 7681, localPort: await freePort(),
    serverPublicKey: serverKP.publicKey.toString('base64'),
  };
  const client = new MeshClient(peer, 'dev-self');
  after(() => client.stop());
  after(() => wss.close());

  client.start();
  const json = await waitFor(() => handshakeJson ?? undefined);
  assert.equal(json.peer_device_id, 'dev-self');
  assert.ok(json.client_public_key);
});

test('MeshClient: omits peer_device_id when no ownDeviceId given', async () => {
  const serverKP = crypto.generateKeyPair();
  let handshakeJson: any = null;
  const wss = new WS.WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => {
    ws.on('message', (raw: Buffer) => {
      if (raw[0] === MSG_HANDSHAKE) handshakeJson = JSON.parse(raw.subarray(1).toString());
    });
  });
  const port: number = await new Promise(r =>
    wss.on('listening', () => r((wss.address() as net.AddressInfo).port)));

  const peer: MeshPeer = {
    name: 'p', deviceId: 'dev-R', relayURL: `ws://127.0.0.1:${port}`,
    pairingSecret: 's', remotePort: 7681, localPort: await freePort(),
    serverPublicKey: serverKP.publicKey.toString('base64'),
  };
  const client = new MeshClient(peer); // no ownDeviceId
  after(() => client.stop());
  after(() => wss.close());

  client.start();
  const json = await waitFor(() => handshakeJson ?? undefined);
  assert.equal(json.peer_device_id, undefined);
});

test('MeshClient: MESH_EVICT triggers onEvicted once and stops permanently', async () => {
  const serverKP = crypto.generateKeyPair();
  let connections = 0;
  const wss = new WS.WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => {
    connections++;
    ws.on('message', (raw: Buffer) => {
      if (raw[0] === MSG_HANDSHAKE) {
        const { client_public_key } = JSON.parse(raw.subarray(1).toString());
        const symKey = crypto.deriveKey(
          crypto.computeSharedSecret(serverKP.privateKey, Buffer.from(client_public_key, 'base64')));
        const inner = Buffer.alloc(5);
        inner[0] = MESH_EVICT; // flowId 0, no payload
        send(ws, MSG_DATA, crypto.encrypt(inner, symKey));
      }
    });
  });
  const port: number = await new Promise(r =>
    wss.on('listening', () => r((wss.address() as net.AddressInfo).port)));

  const evicted: string[] = [];
  const peer: MeshPeer = {
    name: 'p', deviceId: 'dev-R', relayURL: `ws://127.0.0.1:${port}`,
    pairingSecret: 's', remotePort: 7681, localPort: await freePort(),
    serverPublicKey: serverKP.publicKey.toString('base64'),
  };
  const client = new MeshClient(peer, 'dev-self', (id) => evicted.push(id));
  after(() => client.stop());
  after(() => wss.close());

  client.start();
  await waitFor(() => (evicted.length > 0 ? evicted : undefined));
  assert.deepEqual(evicted, ['dev-R']);

  // Permanent stop: no reconnect, callback fires exactly once.
  const before = connections;
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(connections, before, 'must not reconnect after eviction');
  assert.equal(evicted.length, 1, 'onEvicted fires exactly once');
});

test('MeshClient: MESH_RETRY reconnects and never calls onEvicted', async () => {
  const serverKP = crypto.generateKeyPair();
  let connections = 0;
  const wss = new WS.WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => {
    connections++;
    ws.on('message', (raw: Buffer) => {
      if (raw[0] === MSG_HANDSHAKE) {
        const { client_public_key } = JSON.parse(raw.subarray(1).toString());
        const symKey = crypto.deriveKey(
          crypto.computeSharedSecret(serverKP.privateKey, Buffer.from(client_public_key, 'base64')));
        const inner = Buffer.alloc(5);
        inner[0] = MESH_RETRY; // "not ready yet" — peer should reconnect, not give up
        send(ws, MSG_DATA, crypto.encrypt(inner, symKey));
      }
    });
  });
  const port: number = await new Promise(r =>
    wss.on('listening', () => r((wss.address() as net.AddressInfo).port)));

  const evicted: string[] = [];
  const peer: MeshPeer = {
    name: 'p', deviceId: 'dev-R', relayURL: `ws://127.0.0.1:${port}`,
    pairingSecret: 's', remotePort: 7681, localPort: await freePort(),
    serverPublicKey: serverKP.publicKey.toString('base64'),
  };
  const client = new MeshClient(peer, 'dev-self', (id) => evicted.push(id));
  after(() => client.stop());
  after(() => wss.close());

  client.start();
  // First retry cycle is ~2s (1000*2^1); wait long enough to see a reconnect.
  await waitFor(() => (connections >= 2 ? connections : undefined), 8000);
  assert.ok(connections >= 2, 'client reconnects after MESH_RETRY');
  assert.deepEqual(evicted, [], 'MESH_RETRY must NOT trigger onEvicted');
});

test('MeshClient: forwardStates excludes the ttyd forward', async () => {
  const serverKP = crypto.generateKeyPair();
  const relay = await mockRelay(serverKP);
  const ttydLocal = await freePort();

  const peer: MeshPeer = {
    name: 'plain-peer',
    deviceId: 'dev-plain',
    relayURL: relay.url,
    pairingSecret: 'secret',
    remotePort: 7681,
    localPort: ttydLocal,
    serverPublicKey: serverKP.publicKey.toString('base64'),
  };

  const client = new MeshClient(peer);
  after(() => client.stop());
  after(() => relay.close());

  client.start();
  await relay.waitForPFOpens(1);
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(client.forwardStates(), []);
});

test('isConnected: false before start (no socket)', () => {
  const mc = new MeshClient({
    name: 'peer', deviceId: 'dev1', relayURL: 'http://127.0.0.1:1', pairingSecret: 's', localPort: 8888,
  } as any);
  assert.equal(mc.isConnected(), false);
});

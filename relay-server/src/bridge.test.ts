import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Bridge, localWsUrlFor, coalesceOutputFrames } from './bridge.js';
import { AGENT_EVENT } from './agent/frames.js';
import * as crypto from './crypto.js';

const MSG_HANDSHAKE = 0x01;
const MSG_HANDSHAKE_ACK = 0x02;
const MSG_DATA = 0x03;
const MESH_EVICT = 0x50;
const MESH_RETRY = 0x52;

// Stands in for RelayClient: captures send() and lets tests drive events.
class FakeRelay extends EventEmitter {
  sent: { type: number; connId: number; payload: Buffer }[] = [];
  send(type: number, connId: number, payload: Buffer) {
    this.sent.push({ type, connId, payload });
  }
}

// Derive the symmetric key the bridge will use, from the client's side.
function clientKeyFor(serverPub: Buffer) {
  const kp = crypto.generateKeyPair();
  const symKey = crypto.deriveKey(crypto.computeSharedSecret(kp.privateKey, serverPub));
  return { clientPub: kp.publicKey, symKey };
}

function handshake(clientPub: Buffer, peerDeviceId?: string): Buffer {
  return Buffer.from(JSON.stringify({
    client_public_key: clientPub.toString('base64'),
    ...(peerDeviceId ? { peer_device_id: peerDeviceId } : {}),
  }));
}

test('Bridge: asks an unknown peer to RETRY while active (no permanent evict)', () => {
  const serverKP = crypto.generateKeyPair();
  const relay = new FakeRelay();
  const bridge = new Bridge('ws://127.0.0.1:1', relay as any, serverKP);
  bridge.start();
  bridge.setMeshActiveCheck(() => true);            // we are in the mesh
  bridge.setMeshMembershipCheck((id) => id === 'known');

  const connId = 1;
  relay.emit('client_connect', connId, Buffer.alloc(0));
  const { clientPub, symKey } = clientKeyFor(serverKP.publicKey);
  relay.emit('message', MSG_HANDSHAKE, connId, handshake(clientPub, 'stranger'));

  assert.equal(relay.sent.filter(m => m.type === MSG_HANDSHAKE_ACK).length, 0,
    'no handshake ack for a not-yet-known peer');
  const datas = relay.sent.filter(m => m.type === MSG_DATA);
  assert.equal(datas.length, 1, 'exactly one control message');
  const inner = crypto.decrypt(datas[0].payload, symKey);
  assert.equal(inner[0], MESH_RETRY, 'active server asks unknown peer to retry, not evict');

  bridge.stop();
});

test('Bridge: permanently EVICTS a mesh peer when the server is inactive (left/expired)', () => {
  const serverKP = crypto.generateKeyPair();
  const relay = new FakeRelay();
  const bridge = new Bridge('ws://127.0.0.1:1', relay as any, serverKP);
  bridge.start();
  bridge.setMeshActiveCheck(() => false);           // we have left/expired
  bridge.setMeshMembershipCheck(() => true);        // even a "known" peer

  const connId = 1;
  relay.emit('client_connect', connId, Buffer.alloc(0));
  const { clientPub, symKey } = clientKeyFor(serverKP.publicKey);
  relay.emit('message', MSG_HANDSHAKE, connId, handshake(clientPub, 'known'));

  assert.equal(relay.sent.filter(m => m.type === MSG_HANDSHAKE_ACK).length, 0,
    'no handshake ack for an evicted peer');
  const datas = relay.sent.filter(m => m.type === MSG_DATA);
  assert.equal(datas.length, 1, 'exactly one evict message');
  const inner = crypto.decrypt(datas[0].payload, symKey);
  assert.equal(inner[0], MESH_EVICT, 'inactive server permanently evicts');

  bridge.stop();
});

test('Bridge: does not evict a known mesh peer', () => {
  const serverKP = crypto.generateKeyPair();
  const relay = new FakeRelay();
  const bridge = new Bridge('ws://127.0.0.1:1', relay as any, serverKP);
  bridge.start();
  bridge.setMeshMembershipCheck((id) => id === 'known');

  const connId = 2;
  relay.emit('client_connect', connId, Buffer.alloc(0));
  const { clientPub } = clientKeyFor(serverKP.publicKey);
  relay.emit('message', MSG_HANDSHAKE, connId, handshake(clientPub, 'known'));

  assert.equal(relay.sent.filter(m => m.type === MSG_HANDSHAKE_ACK).length, 1,
    'known peer gets a handshake ack');
  assert.equal(relay.sent.filter(m => m.type === MSG_DATA).length, 0,
    'no evict message for a known peer');

  bridge.stop();
});

test('Bridge: never evicts a phone client (no peer_device_id)', () => {
  const serverKP = crypto.generateKeyPair();
  const relay = new FakeRelay();
  const bridge = new Bridge('ws://127.0.0.1:1', relay as any, serverKP);
  bridge.start();
  bridge.setMeshMembershipCheck(() => false); // reject everything checkable

  const connId = 3;
  relay.emit('client_connect', connId, Buffer.alloc(0));
  const { clientPub } = clientKeyFor(serverKP.publicKey);
  relay.emit('message', MSG_HANDSHAKE, connId, handshake(clientPub)); // no peer_device_id

  assert.equal(relay.sent.filter(m => m.type === MSG_HANDSHAKE_ACK).length, 1,
    'phone client gets a handshake ack even when the check rejects all');
  assert.equal(relay.sent.filter(m => m.type === MSG_DATA).length, 0,
    'no evict message for a phone client');

  bridge.stop();
});

test('Bridge: notifyPhonesSelfEject sends 0x51 to phone sessions only', () => {
  const SELF_EJECT_NOTICE = 0x51;
  const serverKP = crypto.generateKeyPair();
  const relay = new FakeRelay();
  const bridge = new Bridge('ws://127.0.0.1:1', relay as any, serverKP);
  bridge.start();
  bridge.setMeshMembershipCheck(() => true);

  // Phone session: handshake WITHOUT peer_device_id.
  const phoneId = 10;
  relay.emit('client_connect', phoneId, Buffer.alloc(0));
  const phone = clientKeyFor(serverKP.publicKey);
  relay.emit('message', MSG_HANDSHAKE, phoneId, handshake(phone.clientPub));

  // Mesh session: handshake WITH peer_device_id.
  const meshId = 11;
  relay.emit('client_connect', meshId, Buffer.alloc(0));
  const peer = clientKeyFor(serverKP.publicKey);
  relay.emit('message', MSG_HANDSHAKE, meshId, handshake(peer.clientPub, 'known'));

  relay.sent.length = 0; // ignore handshake acks
  bridge.notifyPhonesSelfEject('dev-abc');

  const datas = relay.sent.filter(m => m.type === MSG_DATA);
  assert.equal(datas.length, 1, 'exactly one notice, to the phone session only');
  assert.equal(datas[0].connId, phoneId);
  const inner = crypto.decrypt(datas[0].payload, phone.symKey);
  assert.equal(inner[0], SELF_EJECT_NOTICE);
  assert.deepEqual(JSON.parse(inner.subarray(1).toString()), { deviceId: 'dev-abc' });

  bridge.stop();
});

test('localWsUrlFor: a phone carries both its session and the multiplexer', () => {
  assert.equal(
    localWsUrlFor('ws://127.0.0.1:7681/ws', 'phone-1', 'herdr'),
    'ws://127.0.0.1:7681/ws?arg=phone-1&arg=herdr',
  );
});

test('localWsUrlFor: no phone id means no args — the wrapper reads the sidecar', () => {
  assert.equal(localWsUrlFor('ws://127.0.0.1:7681/ws', null, 'herdr'), 'ws://127.0.0.1:7681/ws');
});

test('localWsUrlFor: url-encodes a hostile phone id in both positions', () => {
  assert.equal(
    localWsUrlFor('ws://x/ws', 'a&arg=evil', 'tmux'),
    'ws://x/ws?arg=a%26arg%3Devil&arg=tmux',
  );
});

test('localWsUrlFor: attach mode sends the session name verbatim plus the mux and attach flag', () => {
  assert.equal(
    localWsUrlFor('ws://x/ws', 'phone-1', 'herdr', { name: 'web.app-server', mux: 'herdr' }),
    'ws://x/ws?arg=web.app-server&arg=herdr&arg=1',
  );
});

test('Bridge: phone handshake with phone_id emits cluster_paired', () => {
  const serverKP = crypto.generateKeyPair();
  const relay = new FakeRelay();
  const bridge = new Bridge('ws://127.0.0.1:1', relay as any, serverKP);
  bridge.start();

  const events: Array<{ phoneId: string; pairedAt: number }> = [];
  bridge.on('cluster_paired', (e: { phoneId: string; pairedAt: number }) => events.push(e));

  const connId = 7;
  relay.emit('client_connect', connId, Buffer.alloc(0));
  const phone = clientKeyFor(serverKP.publicKey);
  const payload = Buffer.from(JSON.stringify({
    client_public_key: phone.clientPub.toString('base64'),
    phone_id: 'PHONE-1',
    paired_at: 1_700_000_000_000,
  }));
  relay.emit('message', MSG_HANDSHAKE, connId, payload);

  assert.deepEqual(events, [{ phoneId: 'PHONE-1', pairedAt: 1_700_000_000_000 }]);
  bridge.stop();
});

test('Bridge: a dropped relay uplink tears down every session (no orphaned ttyd/tmux)', () => {
  const serverKP = crypto.generateKeyPair();
  const relay = new FakeRelay();
  const bridge = new Bridge('ws://127.0.0.1:1', relay as any, serverKP);
  bridge.start();

  const gone: number[] = [];
  bridge.on('client_disconnected', (id: number) => gone.push(id));

  relay.emit('client_connect', 1, Buffer.alloc(0));
  relay.emit('client_connect', 2, Buffer.alloc(0));

  // Uplink drops — the relay backend force-closes all phones on our reconnect,
  // so both sessions must be reaped now rather than lingering for a CLIENT_OFFLINE.
  relay.emit('disconnected');
  assert.deepEqual([...gone].sort(), [1, 2], 'both sessions torn down on relay disconnect');

  // Those connIds are now unknown; a late frame is dropped without throwing.
  relay.emit('message', MSG_DATA, 1, Buffer.alloc(4));

  bridge.stop();
});

const out = (s: string) => Buffer.concat([Buffer.from([0x30]), Buffer.from(s)]);

test('coalesceOutputFrames merges consecutive OUTPUT frames and preserves framing', () => {
  const title = Buffer.concat([Buffer.from([0x31]), Buffer.from('title')]);
  const merged = coalesceOutputFrames([out('a'), out('b'), title, out('c'), out('d')]);
  assert.equal(merged.length, 3, 'two output runs + the untouched title frame');
  assert.deepEqual(merged[0], out('ab'), 'first run merged, single 0x30 prefix');
  assert.deepEqual(merged[1], title, 'non-output frame passes through unchanged');
  assert.deepEqual(merged[2], out('cd'), 'second run merged after the title');
});

test('coalesceOutputFrames caps a merged frame at maxBytes', () => {
  const body100 = Buffer.concat([Buffer.from([0x30]), Buffer.alloc(100)]);
  const merged = coalesceOutputFrames([body100, body100, body100], 150);
  assert.equal(merged.length, 3, 'each 100B body exceeds the 150B cap when combined, so no merge');
});

test('coalesceOutputFrames is a no-op for a single output frame', () => {
  const merged = coalesceOutputFrames([out('solo')]);
  assert.deepEqual(merged, [out('solo')]);
});

// --- Multiplexer control frames (0x53 / 0x54) -------------------------------
//
// The multiplexer is a machine-wide setting, so a phone changes it with an
// explicit, auditable frame rather than a handshake field — a reconnecting
// phone carrying a stale value must never silently flip the machine back.

function phoneSession(bridge: Bridge, relay: FakeRelay, serverKP: ReturnType<typeof crypto.generateKeyPair>, connId: number) {
  relay.emit('client_connect', connId, Buffer.alloc(0));
  const phone = clientKeyFor(serverKP.publicKey);
  relay.emit('message', MSG_HANDSHAKE, connId, handshake(phone.clientPub));
  return phone;
}

test('SET_MULTIPLEXER: a valid name is accepted and emitted once', () => {
  const serverKP = crypto.generateKeyPair();
  const relay = new FakeRelay();
  const bridge = new Bridge('ws://127.0.0.1:1', relay as any, serverKP);
  bridge.start();
  bridge.setMeshMembershipCheck(() => true);
  const phone = phoneSession(bridge, relay, serverKP, 20);

  const seen: string[] = [];
  bridge.on('multiplexer_set', (m: string) => seen.push(m));
  const inner = Buffer.concat([Buffer.from([0x53]), Buffer.from(JSON.stringify({ multiplexer: 'herdr' }))]);
  relay.emit('message', MSG_DATA, 20, crypto.encrypt(inner, phone.symKey));

  assert.deepEqual(seen, ['herdr']);
  bridge.stop();
});

test('SET_MULTIPLEXER: an unknown name is ignored, not coerced to tmux', () => {
  const serverKP = crypto.generateKeyPair();
  const relay = new FakeRelay();
  const bridge = new Bridge('ws://127.0.0.1:1', relay as any, serverKP);
  bridge.start();
  bridge.setMeshMembershipCheck(() => true);
  const phone = phoneSession(bridge, relay, serverKP, 21);

  const seen: string[] = [];
  bridge.on('multiplexer_set', (m: string) => seen.push(m));
  const inner = Buffer.concat([Buffer.from([0x53]), Buffer.from(JSON.stringify({ multiplexer: 'zellij' }))]);
  relay.emit('message', MSG_DATA, 21, crypto.encrypt(inner, phone.symKey));

  assert.deepEqual(seen, []);
  bridge.stop();
});

test('SET_MULTIPLEXER: malformed JSON is dropped without throwing', () => {
  const serverKP = crypto.generateKeyPair();
  const relay = new FakeRelay();
  const bridge = new Bridge('ws://127.0.0.1:1', relay as any, serverKP);
  bridge.start();
  bridge.setMeshMembershipCheck(() => true);
  const phone = phoneSession(bridge, relay, serverKP, 22);

  const inner = Buffer.concat([Buffer.from([0x53]), Buffer.from('not json')]);
  assert.doesNotThrow(() => {
    relay.emit('message', MSG_DATA, 22, crypto.encrypt(inner, phone.symKey));
  });
  bridge.stop();
});

test('MULTIPLEXER_STATE: broadcast reaches phone sessions with active + installed', () => {
  const serverKP = crypto.generateKeyPair();
  const relay = new FakeRelay();
  const bridge = new Bridge('ws://127.0.0.1:1', relay as any, serverKP);
  bridge.start();
  bridge.setMeshMembershipCheck(() => true);
  const phone = phoneSession(bridge, relay, serverKP, 23);

  relay.sent.length = 0;
  bridge.broadcastMultiplexerState('herdr', { tmux: true, herdr: true });

  const datas = relay.sent.filter(m => m.type === MSG_DATA);
  assert.equal(datas.length, 1);
  const inner = crypto.decrypt(datas[0].payload, phone.symKey);
  assert.equal(inner[0], 0x54);
  assert.deepEqual(JSON.parse(inner.subarray(1).toString()), {
    active: 'herdr',
    installed: { tmux: true, herdr: true },
  });
  bridge.stop();
});

// --- Agent control frames (0x60-0x68) ---------------------------------------
//
// The bridge stays transport-only: it decodes an agent frame, emits it, and
// never learns what an agent session is. Anything malformed is dropped so a
// bad control frame can never disturb the terminal data path sharing the socket.

/**
 * A started bridge with one handshaken phone on connId 1.
 *
 * `forwardedToTtyd()` reads the session's pending local frames: the local ttyd
 * socket is still CONNECTING against a dead port, so anything the bridge means
 * for ttyd lands there rather than being lost.
 */
function makeBridgeWithSession() {
  const serverKP = crypto.generateKeyPair();
  const relay = new FakeRelay();
  const bridge = new Bridge('ws://127.0.0.1:1', relay as any, serverKP);
  bridge.start();
  bridge.setMeshMembershipCheck(() => true);
  const phone = phoneSession(bridge, relay, serverKP, 1);

  return {
    bridge,
    relay,
    phone,
    sendInner: (inner: Buffer) => relay.emit('message', MSG_DATA, 1, crypto.encrypt(inner, phone.symKey)),
    forwardedToTtyd: (): Buffer[] => (bridge as any).sessions.get(1)?.pendingLocalFrames ?? [],
  };
}

test('AGENT_LIST: a well-formed frame emits agent_list once', () => {
  const { bridge, sendInner } = makeBridgeWithSession();
  let calls = 0;
  bridge.on('agent_list', () => { calls += 1; });

  sendInner(Buffer.concat([Buffer.from([0x60]), Buffer.from('{}')]));

  assert.equal(calls, 1);
  bridge.stop();
});

test('AGENT_ATTACH: emits the requested session and seq', () => {
  const { bridge, sendInner } = makeBridgeWithSession();
  const seen: unknown[] = [];
  bridge.on('agent_attach', (payload: unknown) => seen.push(payload));

  sendInner(Buffer.concat([
    Buffer.from([0x62]),
    Buffer.from(JSON.stringify({ agent: 'claude', sessionId: 's1', sinceSeq: 7 })),
  ]));

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { connId: 1, agent: 'claude', sessionId: 's1', sinceSeq: 7 });
  bridge.stop();
});

test('AGENT_ATTACH: a malformed payload is dropped without throwing or emitting', () => {
  const { bridge, sendInner } = makeBridgeWithSession();
  let calls = 0;
  bridge.on('agent_attach', () => { calls += 1; });

  assert.doesNotThrow(() => sendInner(Buffer.concat([Buffer.from([0x62]), Buffer.from('{not json')])));
  assert.equal(calls, 0);
  bridge.stop();
});

test('AGENT_ATTACH: an unknown agent name is ignored rather than defaulted', () => {
  const { bridge, sendInner } = makeBridgeWithSession();
  let calls = 0;
  bridge.on('agent_attach', () => { calls += 1; });

  sendInner(Buffer.concat([
    Buffer.from([0x62]),
    Buffer.from(JSON.stringify({ agent: 'gemini', sessionId: 's1', sinceSeq: 0 })),
  ]));

  assert.equal(calls, 0);
  bridge.stop();
});

test('AGENT_PERMISSION: a behavior outside allow/deny is ignored, never coerced', () => {
  const { bridge, sendInner } = makeBridgeWithSession();
  let calls = 0;
  bridge.on('agent_permission', () => { calls += 1; });

  sendInner(Buffer.concat([
    Buffer.from([0x65]),
    Buffer.from(JSON.stringify({ requestId: 'r1', behavior: 'ALLOW' })),
  ]));

  assert.equal(calls, 0);
  bridge.stop();
});

test('agent opcodes never reach ttyd', () => {
  const { bridge, sendInner, forwardedToTtyd } = makeBridgeWithSession();

  sendInner(Buffer.concat([Buffer.from([0x60]), Buffer.from('{}')]));

  assert.equal(forwardedToTtyd().length, 0);
  bridge.stop();
});

test('a ttyd data frame is still forwarded untouched', () => {
  const { bridge, sendInner, forwardedToTtyd } = makeBridgeWithSession();
  const payload = Buffer.from('0hello');

  sendInner(payload);

  assert.deepEqual(forwardedToTtyd(), [payload]);
  bridge.stop();
});

test('sendAgentFrame: encrypts an agent frame to one phone', () => {
  const { bridge, relay, phone } = makeBridgeWithSession();

  relay.sent.length = 0;
  bridge.sendAgentFrame(1, 0x61, { sessions: [] });

  const datas = relay.sent.filter(m => m.type === MSG_DATA);
  assert.equal(datas.length, 1);
  const inner = crypto.decrypt(datas[0].payload, phone.symKey);
  assert.equal(inner[0], 0x61);
  assert.deepEqual(JSON.parse(inner.subarray(1).toString()), { sessions: [] });
  bridge.stop();
});

test('AGENT_ATTACH: logs a parseable [agent] line', () => {
  const { bridge, sendInner } = makeBridgeWithSession();
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); };

  sendInner(Buffer.concat([
    Buffer.from([0x62]),
    Buffer.from(JSON.stringify({ agent: 'claude', sessionId: 's1', sinceSeq: 7 })),
  ]));

  console.log = orig;
  bridge.stop();

  assert.ok(lines.some((l) => l.startsWith('[agent] -> conn=1 agent=claude session=s1 type=attach sinceSeq=7')),
    `expected an attach log line, got: ${lines.join('\n')}`);
});

test('TERMINAL_ATTACH: logs an [attach] decision line', () => {
  const { bridge, sendInner } = makeBridgeWithSession();
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); };

  sendInner(Buffer.concat([
    Buffer.from([0x57]),
    Buffer.from(JSON.stringify({ kind: 'herdr', name: 'work' })),
  ]));

  console.log = orig;
  bridge.stop();

  assert.ok(lines.some((l) => l.startsWith('[attach] conn=1 target=herdr:work mux=herdr')),
    `expected an attach decision line, got: ${lines.join('\n')}`);
});

test('AGENT_QUESTION: logs answers as JSON so the desktop parser can read them back', () => {
  // Default interpolation would render ['yes','ship it'] as `answers=yes,ship it`,
  // which the tray's key=value tokenizer splits at the space. Arrays are JSON.
  const { bridge, sendInner } = makeBridgeWithSession();
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); };

  sendInner(Buffer.concat([
    Buffer.from([0x69]),
    Buffer.from(JSON.stringify({ requestId: 'q1', answers: ['yes', 'ship it'] })),
  ]));

  console.log = orig;
  bridge.stop();

  assert.ok(lines.some((l) => l.includes('answers=["yes","ship it"]')),
    `expected a JSON answers field, got: ${lines.join('\n')}`);
});

test('sendAgentFrame: logs server→phone events', () => {
  const { bridge, sendInner } = makeBridgeWithSession();
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m: string) => { lines.push(m); };

  bridge.sendAgentFrame(1, AGENT_EVENT, { kind: 'status', sessionId: 's1', seq: -1, status: 'error', detail: 'boom' });

  console.log = orig;
  bridge.stop();

  assert.ok(lines.some((l) => l.startsWith('[agent] <- conn=1 session=s1 type=status value=error') && l.includes('detail=boom')),
    `expected a status log line, got: ${lines.join('\n')}`);
});

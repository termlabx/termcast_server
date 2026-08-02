import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Bridge, localWsUrlFor, coalesceOutputFrames } from './bridge.js';
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

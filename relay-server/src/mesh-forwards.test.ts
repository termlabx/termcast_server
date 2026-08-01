import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  forwardsFromInvite,
  forwardsFromDisk,
  mergeMeshForwards,
  applyForwardChange,
  isValidPort,
  type MeshForward,
} from './mesh-forwards.js';

// ── isValidPort ──────────────────────────────────────────────────────────────

test('isValidPort accepts 1..65535 integers only', () => {
  assert.equal(isValidPort(1), true);
  assert.equal(isValidPort(65535), true);
  assert.equal(isValidPort(0), false);
  assert.equal(isValidPort(65536), false);
  assert.equal(isValidPort(3.14), false);
  assert.equal(isValidPort('3000'), false);
  assert.equal(isValidPort(undefined), false);
});

// ── forwardsFromInvite ───────────────────────────────────────────────────────

test('forwardsFromInvite parses entries and forces source invite', () => {
  const got = forwardsFromInvite([
    { remotePort: 3000, localPort: 3000 },
    { remotePort: 8080, localPort: 18080, source: 'local' }, // source must be ignored
  ]);
  assert.deepEqual(got, [
    { remotePort: 3000, localPort: 3000, source: 'invite' },
    { remotePort: 8080, localPort: 18080, source: 'invite' },
  ]);
});

test('forwardsFromInvite defaults localPort to remotePort', () => {
  assert.deepEqual(forwardsFromInvite([{ remotePort: 5432 }]), [
    { remotePort: 5432, localPort: 5432, source: 'invite' },
  ]);
});

test('forwardsFromInvite drops invalid entries and non-arrays', () => {
  assert.deepEqual(forwardsFromInvite(undefined), []);
  assert.deepEqual(forwardsFromInvite('junk'), []);
  assert.deepEqual(forwardsFromInvite([
    null,
    'junk',
    { remotePort: 0 },
    { remotePort: 70000 },
    { remotePort: 3000, localPort: 'x' },
  ]), []);
});

test('forwardsFromInvite dedupes by remotePort, first wins', () => {
  const got = forwardsFromInvite([
    { remotePort: 3000, localPort: 3000 },
    { remotePort: 3000, localPort: 13000 },
  ]);
  assert.deepEqual(got, [{ remotePort: 3000, localPort: 3000, source: 'invite' }]);
});

// ── forwardsFromDisk ─────────────────────────────────────────────────────────

test('forwardsFromDisk preserves a stored local source', () => {
  const got = forwardsFromDisk([
    { remotePort: 3000, localPort: 3000, source: 'local' },
    { remotePort: 8080, localPort: 8080, source: 'invite' },
    { remotePort: 9090, localPort: 9090 }, // missing source -> invite
  ]);
  assert.deepEqual(got, [
    { remotePort: 3000, localPort: 3000, source: 'local' },
    { remotePort: 8080, localPort: 8080, source: 'invite' },
    { remotePort: 9090, localPort: 9090, source: 'invite' },
  ]);
});

test('forwardsFromDisk tolerates missing field (back-compat peers.json)', () => {
  assert.deepEqual(forwardsFromDisk(undefined), []);
});

// ── mergeMeshForwards ────────────────────────────────────────────────────────

test('merge: local forwards survive an invite that lacks them', () => {
  const existing: MeshForward[] = [
    { remotePort: 3000, localPort: 3000, source: 'local' },
    { remotePort: 8080, localPort: 8080, source: 'invite' },
  ];
  const got = mergeMeshForwards(existing, []);
  assert.deepEqual(got, [{ remotePort: 3000, localPort: 3000, source: 'local' }]);
});

test('merge: incoming invite replaces previous invite forwards', () => {
  const existing: MeshForward[] = [{ remotePort: 8080, localPort: 8080, source: 'invite' }];
  const incoming: MeshForward[] = [{ remotePort: 5432, localPort: 5432, source: 'invite' }];
  assert.deepEqual(mergeMeshForwards(existing, incoming), [
    { remotePort: 5432, localPort: 5432, source: 'invite' },
  ]);
});

test('merge: on remotePort collision, local wins', () => {
  const existing: MeshForward[] = [{ remotePort: 3000, localPort: 13000, source: 'local' }];
  const incoming: MeshForward[] = [{ remotePort: 3000, localPort: 3000, source: 'invite' }];
  assert.deepEqual(mergeMeshForwards(existing, incoming), [
    { remotePort: 3000, localPort: 13000, source: 'local' },
  ]);
});

// ── applyForwardChange ───────────────────────────────────────────────────────

const peers = () => ([
  { name: 'Kate Mac', deviceId: 'dev-aaa', remotePort: 7681, localPort: 9701, forwards: [] as MeshForward[] },
  { name: 'Studio', deviceId: 'dev-bbb', remotePort: 7681, localPort: 9702,
    forwards: [{ remotePort: 8080, localPort: 8080, source: 'invite' as const }] },
]);

test('applyForwardChange adds a local-sourced forward', () => {
  const r = applyForwardChange(peers(), { peer: 'kate mac', action: 'add', remotePort: 3000, localPort: 3000 });
  assert.ok(r.ok);
  assert.deepEqual(r.peer.forwards, [{ remotePort: 3000, localPort: 3000, source: 'local' }]);
  // other peers untouched
  assert.deepEqual(r.peers.find(p => p.deviceId === 'dev-bbb')!.forwards,
    [{ remotePort: 8080, localPort: 8080, source: 'invite' }]);
});

test('applyForwardChange defaults localPort to remotePort', () => {
  const r = applyForwardChange(peers(), { peer: 'Studio', action: 'add', remotePort: 3000 });
  assert.ok(r.ok);
  assert.ok(r.peer.forwards!.some(f => f.remotePort === 3000 && f.localPort === 3000));
});

test('applyForwardChange matches by deviceId prefix', () => {
  const r = applyForwardChange(peers(), { peer: 'dev-b', action: 'add', remotePort: 3000 });
  assert.ok(r.ok);
  assert.equal(r.peer.name, 'Studio');
});

test('applyForwardChange rejects unknown and ambiguous peers', () => {
  const r1 = applyForwardChange(peers(), { peer: 'nope', action: 'add', remotePort: 3000 });
  assert.ok(!r1.ok);
  const r2 = applyForwardChange(peers(), { peer: 'dev-', action: 'add', remotePort: 3000 });
  assert.ok(!r2.ok && /multiple/.test(r2.error));
});

test('applyForwardChange rejects the peer ttyd port', () => {
  const r = applyForwardChange(peers(), { peer: 'Studio', action: 'add', remotePort: 7681 });
  assert.ok(!r.ok && /terminal port/.test(r.error));
});

test('applyForwardChange rejects a duplicate local port on the same peer', () => {
  const r = applyForwardChange(peers(), { peer: 'Studio', action: 'add', remotePort: 3000, localPort: 8080 });
  assert.ok(!r.ok && /already used/.test(r.error));
});

test('applyForwardChange add upserts an existing remotePort as local', () => {
  const r = applyForwardChange(peers(), { peer: 'Studio', action: 'add', remotePort: 8080, localPort: 18080 });
  assert.ok(r.ok);
  assert.deepEqual(r.peer.forwards, [{ remotePort: 8080, localPort: 18080, source: 'local' }]);
  assert.ok(r.note); // mentions the replacement
});

test('applyForwardChange removes a forward', () => {
  const r = applyForwardChange(peers(), { peer: 'Studio', action: 'remove', remotePort: 8080 });
  assert.ok(r.ok);
  assert.deepEqual(r.peer.forwards, []);
  assert.ok(r.note && /invite/.test(r.note)); // invite-sourced: warns it may return
});

test('applyForwardChange remove of unknown forward errors', () => {
  const r = applyForwardChange(peers(), { peer: 'Studio', action: 'remove', remotePort: 9999 });
  assert.ok(!r.ok);
});

test('applyForwardChange rejects invalid ports', () => {
  assert.ok(!applyForwardChange(peers(), { peer: 'Studio', action: 'add', remotePort: 0 }).ok);
  assert.ok(!applyForwardChange(peers(), { peer: 'Studio', action: 'add', remotePort: 3000, localPort: 99999 }).ok);
});

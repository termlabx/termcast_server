import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttachmentManager } from './attachments.js';
import { AgentRegistry } from './registry.js';
import type { AgentAdapter, AgentEvent, Unsubscribe } from './adapter.js';

/** Counts live subscriptions so leaks are observable. */
function countingAdapter(): { adapter: AgentAdapter; live: () => number } {
  let live = 0;
  const adapter: AgentAdapter = {
    kind: 'claude',
    async list() { return []; },
    async history() { return { messages: [], hasMore: false }; },
    async subscribe(_s, _q, onEvent): Promise<Unsubscribe> {
      live += 1;
      onEvent({ kind: 'status', sessionId: 's1', seq: 1, status: 'turn_start' } as AgentEvent);
      return () => { live -= 1; };
    },
    async send() {}, async interrupt() {}, async respondPermission() {}, async respondQuestion() {},
  };
  return { adapter, live: () => live };
}

test('attach: forwards adapter events to the connection callback', async () => {
  const { adapter } = countingAdapter();
  const manager = new AttachmentManager(new AgentRegistry([adapter]));
  const seen: AgentEvent[] = [];

  await manager.attach(1, 'claude', 's1', 0, (e) => seen.push(e));

  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'status');
});

test('attach: re-attaching the same connection releases the previous subscription', async () => {
  // Without this, every phone reconnect leaks a poller for the life of the process.
  const { adapter, live } = countingAdapter();
  const manager = new AttachmentManager(new AgentRegistry([adapter]));

  await manager.attach(1, 'claude', 's1', 0, () => {});
  await manager.attach(1, 'claude', 's2', 0, () => {});

  assert.equal(live(), 1);
});

test('detach: releases the subscription', async () => {
  const { adapter, live } = countingAdapter();
  const manager = new AttachmentManager(new AgentRegistry([adapter]));

  await manager.attach(1, 'claude', 's1', 0, () => {});
  manager.detach(1);

  assert.equal(live(), 0);
});

test('detach: an unknown connection is a no-op, not a throw', () => {
  const { adapter } = countingAdapter();
  const manager = new AttachmentManager(new AgentRegistry([adapter]));

  assert.doesNotThrow(() => manager.detach(99));
});

test('detachAll: releases every subscription on relay disconnect', async () => {
  const { adapter, live } = countingAdapter();
  const manager = new AttachmentManager(new AgentRegistry([adapter]));

  await manager.attach(1, 'claude', 's1', 0, () => {});
  await manager.attach(2, 'claude', 's2', 0, () => {});
  manager.detachAll();

  assert.equal(live(), 0);
});

test('isAttached: true only while some connection holds the session', async () => {
  const { adapter } = countingAdapter();
  const manager = new AttachmentManager(new AgentRegistry([adapter]));

  await manager.attach(1, 'claude', 's1', 0, () => {});
  assert.equal(manager.isAttached('s1'), true);

  manager.detach(1);
  assert.equal(manager.isAttached('s1'), false);
});

test('connectionsFor: lists every connection watching a session', async () => {
  const { adapter } = countingAdapter();
  const manager = new AttachmentManager(new AgentRegistry([adapter]));

  await manager.attach(1, 'claude', 's1', 0, () => {});
  await manager.attach(2, 'claude', 's1', 0, () => {});
  await manager.attach(3, 'claude', 's2', 0, () => {});

  assert.deepEqual(manager.connectionsFor('s1').sort(), [1, 2]);
});

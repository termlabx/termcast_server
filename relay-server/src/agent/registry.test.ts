import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from './registry.js';
import type { AgentAdapter, AgentEvent, HistoryPage, Unsubscribe } from './adapter.js';
import type { AgentKind, AgentSessionSummary } from './types.js';

function fakeAdapter(kind: AgentKind, sessions: Partial<AgentSessionSummary>[], opts: { failList?: boolean } = {}): AgentAdapter {
  return {
    kind,
    async list() {
      if (opts.failList) throw new Error('boom');
      return sessions.map((s) => ({
        id: 'x', agent: kind, title: 't', projectPath: '/p', lastActiveAt: null,
        isLive: false, messageCount: null, model: null, needsAttention: false, ...s,
      }));
    },
    async history(): Promise<HistoryPage> { return { messages: [], hasMore: false }; },
    async subscribe(_s, _q, onEvent): Promise<Unsubscribe> {
      onEvent({ kind: 'status', sessionId: 's', seq: 0, status: 'turn_start' } as AgentEvent);
      return () => {};
    },
    async send() {}, async interrupt() {}, async respondPermission() {}, async respondQuestion() {},
  };
}

test('list: merges every adapter, newest first', async () => {
  const registry = new AgentRegistry([
    fakeAdapter('claude', [{ id: 'c1', lastActiveAt: '2026-01-01T00:00:00.000Z' }]),
    fakeAdapter('opencode', [{ id: 'o1', lastActiveAt: '2026-08-01T00:00:00.000Z' }]),
  ]);

  const sessions = await registry.list();

  assert.deepEqual(sessions.map((s) => s.id), ['o1', 'c1']);
});

test('list: one failing adapter does not empty the list', async () => {
  const registry = new AgentRegistry([
    fakeAdapter('claude', [{ id: 'c1' }]),
    fakeAdapter('opencode', [{ id: 'o1' }], { failList: true }),
  ]);

  const sessions = await registry.list();

  assert.deepEqual(sessions.map((s) => s.id), ['c1']);
});

test('adapterFor: unknown kind yields null rather than throwing', () => {
  const registry = new AgentRegistry([fakeAdapter('claude', [])]);

  assert.equal(registry.adapterFor('opencode'), null);
  assert.notEqual(registry.adapterFor('claude'), null);
});

test('history: routing to a missing adapter yields an empty page', async () => {
  const registry = new AgentRegistry([fakeAdapter('claude', [])]);

  const page = await registry.history('opencode', 's1', null, 50);

  assert.deepEqual(page, { messages: [], hasMore: false });
});

test('subscribe: routing to a missing adapter yields a no-op unsubscribe', async () => {
  const registry = new AgentRegistry([fakeAdapter('claude', [])]);
  let called = false;

  const stop = await registry.subscribe('opencode', 's1', 0, () => { called = true; });
  stop();

  assert.equal(called, false);
});

test('list: an adapter added via a provider shows up on the next listing', async () => {
  const state = { opencode: false };
  const registry = new AgentRegistry(() => [
    fakeAdapter('claude', [{ id: 'c1', lastActiveAt: '2026-01-01T00:00:00.000Z' }]),
    ...(state.opencode ? [fakeAdapter('opencode', [{ id: 'o1', lastActiveAt: '2026-08-01T00:00:00.000Z' }])] : []),
  ]);

  const before = await registry.list();
  state.opencode = true;
  const after = await registry.list();

  assert.deepEqual(before.map((s) => s.id), ['c1']);
  assert.deepEqual(after.map((s) => s.id), ['o1', 'c1']);
});

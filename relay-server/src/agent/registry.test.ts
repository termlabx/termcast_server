import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from './registry.js';
import type { AgentAdapter, AgentEvent, HistoryPage, Unsubscribe } from './adapter.js';
import type { AgentKind, AgentSessionSummary } from './types.js';
import { SessionLiveness } from './session-liveness.js';
import type { DeskRegistry, DeskEntry } from './desk-target.js';

/**
 * Deps that touch neither the multiplexer nor the process table: these tests
 * are about routing and merging, so reachability is pinned rather than probed.
 */
const isolated = () => ({
  desk: { async lookup() { return null; }, async list(): Promise<DeskEntry[]> { return []; } } as DeskRegistry,
  liveness: ({ isAlive: async () => false }) as unknown as SessionLiveness,
});

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
  ], isolated());

  const sessions = await registry.list();

  assert.deepEqual(sessions.map((s) => s.id), ['o1', 'c1']);
});

test('list: one failing adapter does not empty the list', async () => {
  const registry = new AgentRegistry([
    fakeAdapter('claude', [{ id: 'c1' }]),
    fakeAdapter('opencode', [{ id: 'o1' }], { failList: true }),
  ], isolated());

  const sessions = await registry.list();

  assert.deepEqual(sessions.map((s) => s.id), ['c1']);
});

test('adapterFor: unknown kind yields null rather than throwing', () => {
  const registry = new AgentRegistry([fakeAdapter('claude', [])], isolated());

  assert.equal(registry.adapterFor('opencode'), null);
  assert.notEqual(registry.adapterFor('claude'), null);
});

test('history: routing to a missing adapter yields an empty page', async () => {
  const registry = new AgentRegistry([fakeAdapter('claude', [])], isolated());

  const page = await registry.history('opencode', 's1', null, 50);

  assert.deepEqual(page, { messages: [], hasMore: false });
});

test('subscribe: routing to a missing adapter yields a no-op unsubscribe', async () => {
  const registry = new AgentRegistry([fakeAdapter('claude', [])], isolated());
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
  ], isolated());

  const before = await registry.list();
  state.opencode = true;
  const after = await registry.list();

  assert.deepEqual(before.map((s) => s.id), ['c1']);
  assert.deepEqual(after.map((s) => s.id), ['o1', 'c1']);
});

const summary = (id: string, agent: 'claude' | 'opencode', projectPath = '/repo') => ({
  id, agent, title: id, projectPath, lastActiveAt: '2026-08-06T00:00:00Z',
  isLive: false, messageCount: null, model: null, needsAttention: false,
});

const adapterListing = (kind: 'claude' | 'opencode', sessions: ReturnType<typeof summary>[]) =>
  ({ kind, list: async () => sessions }) as unknown as AgentAdapter;

const deskListing = (entries: DeskEntry[]): DeskRegistry => ({
  async lookup(agent, sessionId) {
    return entries.find((e) => e.agent === agent && e.sessionId === sessionId)?.target ?? null;
  },
  async list() { return entries; },
});

const livenessFor = (aliveIds: string[]): SessionLiveness =>
  ({ isAlive: async (_a: string, id: string) => aliveIds.includes(id) }) as unknown as SessionLiveness;

test('list: a reachable session is listed and marked live', async () => {
  const registry = new AgentRegistry([adapterListing('claude', [summary('s1', 'claude')])], {
    desk: deskListing([{ agent: 'claude', sessionId: 's1', target: { paneId: 'w1:p1', mux: 'herdr', status: 'idle' } }]),
    liveness: livenessFor(['s1']),
  });

  const sessions = await registry.list();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].isLive, true);
});

test('list: a session nothing holds is listed for headless resume', async () => {
  const registry = new AgentRegistry([adapterListing('claude', [summary('s1', 'claude')])], {
    desk: deskListing([]),
    liveness: livenessFor([]),
  });

  const sessions = await registry.list();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].isLive, false);
});

test('list: a session that is alive but unreachable is hidden', async () => {
  const registry = new AgentRegistry([adapterListing('claude', [summary('s1', 'claude')])], {
    desk: deskListing([]),
    liveness: livenessFor(['s1']),
  });

  assert.deepEqual(await registry.list(), []);
});

test('list: hiding is per session, not per agent', async () => {
  const registry = new AgentRegistry([
    adapterListing('claude', [summary('reachable', 'claude'), summary('hidden', 'claude')]),
  ], {
    desk: deskListing([
      { agent: 'claude', sessionId: 'reachable', target: { paneId: 'w1:p1', mux: 'herdr', status: 'idle' } },
    ]),
    liveness: livenessFor(['reachable', 'hidden']),
  });

  const ids = (await registry.list()).map((s) => s.id);
  assert.deepEqual(ids, ['reachable']);
});

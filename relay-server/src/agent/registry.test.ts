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
  assert.equal(sessions[0].reachable, true);
});

test('list: a session nothing holds is listed for headless resume', async () => {
  const registry = new AgentRegistry([adapterListing('claude', [summary('s1', 'claude')])], {
    desk: deskListing([]),
    liveness: livenessFor([]),
  });

  const sessions = await registry.list();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].isLive, false);
  assert.equal(sessions[0].reachable, true, 'nothing holds it, so a headless resume can take it');
});

// Previously hidden outright. An opencode TUI in tmux has no desk route at all,
// so hiding made *every* opencode session in that project vanish from the phone
// — the reported "can't see the sessions I just created". send() already
// refuses these with an explanation, so hiding was a second guard that only
// cost the user the ability to read the session.
test('list: a session that is alive but unreachable is listed read-only', async () => {
  const registry = new AgentRegistry([adapterListing('claude', [summary('s1', 'claude')])], {
    desk: deskListing([]),
    liveness: livenessFor(['s1']),
  });

  const sessions = await registry.list();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].isLive, true);
  assert.equal(sessions[0].reachable, false);
});

test('list: reachability is per session, not per agent', async () => {
  const registry = new AgentRegistry([
    adapterListing('claude', [summary('reachable', 'claude'), summary('stranded', 'claude')]),
  ], {
    desk: deskListing([
      { agent: 'claude', sessionId: 'reachable', target: { paneId: 'w1:p1', mux: 'herdr', status: 'idle' } },
    ]),
    liveness: livenessFor(['reachable', 'stranded']),
  });

  const sessions = await registry.list();
  assert.deepEqual(sessions.map((s) => [s.id, s.reachable]), [['reachable', true], ['stranded', false]]);
});

// `blocked` is the desk equivalent of a pending permission: the agent has drawn
// a dialog and is waiting on a human. needsAttention already means exactly
// that, so it carries this rather than earning a second flag.
test('list: a desk agent in blocked needs attention', async () => {
  const registry = new AgentRegistry([fakeAdapter('claude', [{ id: 's1' }])], {
    desk: {
      async lookup() { return null; },
      async list(): Promise<DeskEntry[]> {
        return [{
          agent: 'claude', sessionId: 's1',
          target: { paneId: 'w3:p2', mux: 'herdr', status: 'blocked' },
        }];
      },
    } as DeskRegistry,
    liveness: ({ isAlive: async () => false }) as unknown as SessionLiveness,
  });

  const [listed] = await registry.list();
  assert.equal(listed.needsAttention, true);
  assert.equal(listed.reachable, true);
});

test('list: a desk agent that is merely working does not need attention', async () => {
  const registry = new AgentRegistry([fakeAdapter('claude', [{ id: 's1' }])], {
    desk: {
      async lookup() { return null; },
      async list(): Promise<DeskEntry[]> {
        return [{
          agent: 'claude', sessionId: 's1',
          target: { paneId: 'w3:p2', mux: 'herdr', status: 'working' },
        }];
      },
    } as DeskRegistry,
    liveness: ({ isAlive: async () => false }) as unknown as SessionLiveness,
  });

  assert.equal((await registry.list())[0].needsAttention, false);
});

// --- pending question replay ----------------------------------------------

/**
 * Raises its question only on the *first* subscribe, which is what makes the
 * replay observable: a fake that re-asks on every subscribe would pass whether
 * or not the registry remembered anything.
 */
function onceQuestioningAdapter(
  extra?: (onEvent: (e: AgentEvent) => void) => void,
): AgentAdapter {
  let raised = false;
  return {
    kind: 'claude',
    list: async () => [],
    history: async () => ({ messages: [], hasMore: false }),
    subscribe: async (_sessionId: string, _sinceSeq: number, onEvent: (e: AgentEvent) => void) => {
      if (!raised) {
        raised = true;
        onEvent({
          kind: 'question', sessionId: 's1', seq: 1,
          request: {
            requestId: 'r1', sessionId: 's1', agent: 'claude', prompt: 'Pick',
            kind: 'select', options: [{ label: 'A' }], createdAt: '2026-08-07T00:00:00.000Z',
          },
        });
        extra?.(onEvent);
      }
      return () => {};
    },
    send: async () => {},
    interrupt: async () => {},
    respondPermission: async () => {},
    respondQuestion: async () => {},
  } as unknown as AgentAdapter;
}

test('subscribing again replays a question that is still pending', async () => {
  const registry = new AgentRegistry([onceQuestioningAdapter()]);
  await registry.subscribe('claude', 's1', 0, () => {});

  // The relay dropped and the phone came back. The agent is still waiting, so
  // the card has to reappear — nothing else would tell the phone about it.
  const second: AgentEvent[] = [];
  await registry.subscribe('claude', 's1', 0, (e) => second.push(e));

  const replayed = second.filter((e) => e.kind === 'question');
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].kind === 'question' && replayed[0].request.requestId, 'r1');
});

test('a resolved question is not replayed', async () => {
  const registry = new AgentRegistry([onceQuestioningAdapter((onEvent) => {
    onEvent({
      kind: 'questionResolved', sessionId: 's1', seq: 2,
      requestId: 'r1', outcome: 'answered',
    });
  })]);
  await registry.subscribe('claude', 's1', 0, () => {});

  const second: AgentEvent[] = [];
  await registry.subscribe('claude', 's1', 0, (e) => second.push(e));

  assert.equal(second.filter((e) => e.kind === 'question').length, 0);
});

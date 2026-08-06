import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HerdrDeskRegistry, TmuxDeskRegistry, EmptyDeskRegistry, CompositeDeskRegistry,
  deskRegistryFor, defaultDeskRegistry, isInjectable,
  type DeskEntry, type DeskRegistry,
} from './desk-target.js';
import { HerdrAgentCli, type HerdrRunner, type HerdrStatus } from './herdr-agent-cli.js';
import type { LiveSession } from './session-registry.js';

const listOf = (agents: unknown[]): HerdrRunner => async () => ({
  stdout: JSON.stringify({ id: 'cli:agent:list', result: { type: 'agent_list', agents } }),
  stderr: '',
});

const herdrAgent = (over: Record<string, unknown> = {}) => ({
  agent: 'claude',
  agent_session: { kind: 'id', value: 's1' },
  agent_status: 'idle',
  cwd: '/repo',
  pane_id: 'w1:p1',
  ...over,
});

test('herdr lookup: matches on agent and session id together', async () => {
  const reg = new HerdrDeskRegistry(new HerdrAgentCli(listOf([
    herdrAgent({ agent: 'claude', agent_session: { kind: 'id', value: 'dup' }, pane_id: 'w1:p1' }),
    herdrAgent({ agent: 'opencode', agent_session: { kind: 'id', value: 'dup' }, pane_id: 'w2:p2' }),
  ])));

  assert.deepEqual(await reg.lookup('claude', 'dup'), { paneId: 'w1:p1', mux: 'herdr', status: 'idle' });
  assert.deepEqual(await reg.lookup('opencode', 'dup'), { paneId: 'w2:p2', mux: 'herdr', status: 'idle' });
});

test('herdr lookup: an unknown session has no target', async () => {
  const reg = new HerdrDeskRegistry(new HerdrAgentCli(listOf([herdrAgent()])));
  assert.equal(await reg.lookup('claude', 'nope'), null);
});

test('herdr lookup: carries the live status through', async () => {
  const reg = new HerdrDeskRegistry(new HerdrAgentCli(listOf([herdrAgent({ agent_status: 'working' })])));
  assert.equal((await reg.lookup('claude', 's1'))?.status, 'working');
});

test('herdr list: skips agents herdr could not identify', async () => {
  const reg = new HerdrDeskRegistry(new HerdrAgentCli(listOf([
    herdrAgent({ agent_session: { kind: 'id', value: 's1' } }),
    herdrAgent({ agent_session: { kind: 'title', value: 'Some title' }, pane_id: 'w9:p9' }),
  ])));
  const entries = await reg.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sessionId, 's1');
});

test('herdr list: skips agent kinds we do not model', async () => {
  const reg = new HerdrDeskRegistry(new HerdrAgentCli(listOf([
    herdrAgent({ agent: 'aider', agent_session: { kind: 'id', value: 'x' } }),
  ])));
  assert.deepEqual(await reg.list(), []);
});

test('tmux lookup: resolves a claude session that has a pane', async () => {
  const sessions: LiveSession[] = [
    { sessionId: 's1', cwd: '/repo', transcriptPath: '/t', pid: 1, paneId: '%3' },
  ];
  const reg = new TmuxDeskRegistry(() => sessions);
  assert.deepEqual(await reg.lookup('claude', 's1'), { paneId: '%3', mux: 'tmux', status: 'unknown' });
});

test('tmux lookup: a claude session with no pane has no target', async () => {
  const reg = new TmuxDeskRegistry(() => [
    { sessionId: 's1', cwd: '/repo', transcriptPath: '/t', pid: 1, paneId: null },
  ]);
  assert.equal(await reg.lookup('claude', 's1'), null);
});

test('tmux lookup: opencode is never reachable under tmux', async () => {
  const reg = new TmuxDeskRegistry(() => [
    { sessionId: 'ses_1', cwd: '/repo', transcriptPath: '/t', pid: 1, paneId: '%3' },
  ]);
  assert.equal(await reg.lookup('opencode', 'ses_1'), null);
});

test('deskRegistryFor: picks the registry matching the active multiplexer', () => {
  assert.ok(deskRegistryFor('herdr') instanceof HerdrDeskRegistry);
  assert.ok(deskRegistryFor('tmux') instanceof TmuxDeskRegistry);
  assert.ok(deskRegistryFor('none') instanceof EmptyDeskRegistry);
});

test('isInjectable: only a settled agent accepts a prompt', () => {
  assert.equal(isInjectable('idle'), true);
  assert.equal(isInjectable('done'), true);
  assert.equal(isInjectable('working'), false);
  assert.equal(isInjectable('blocked'), false);
  // tmux cannot report a status; refusing there would make the path unusable.
  assert.equal(isInjectable('unknown'), true);
});

/** A machine can run herdr inside tmux, so both hold agent sessions at once. */
const fixedRegistry = (entries: DeskEntry[]): DeskRegistry => ({
  async lookup(agent, sessionId) {
    return entries.find((e) => e.agent === agent && e.sessionId === sessionId)?.target ?? null;
  },
  async list() { return entries; },
});

const entry = (sessionId: string, mux: 'herdr' | 'tmux', paneId: string, status: HerdrStatus = 'idle'): DeskEntry =>
  ({ agent: 'claude', sessionId, target: { paneId, mux, status } });

test('composite lookup: finds a tmux session even when herdr is the active multiplexer', async () => {
  // The reported bug: claude started in tmux, sidecar says herdr, so the send
  // found no target and fell through to a headless resume that the desk never saw.
  const reg = new CompositeDeskRegistry([
    fixedRegistry([entry('herdr-one', 'herdr', 'w3:p2')]),
    fixedRegistry([entry('tmux-one', 'tmux', '%7', 'unknown')]),
  ]);

  assert.deepEqual(await reg.lookup('claude', 'tmux-one'), { paneId: '%7', mux: 'tmux', status: 'unknown' });
});

test('composite lookup: prefers herdr when both claim the session, since only it reports status', async () => {
  const reg = new CompositeDeskRegistry([
    fixedRegistry([entry('dup', 'herdr', 'w3:p2', 'working')]),
    fixedRegistry([entry('dup', 'tmux', '%7', 'unknown')]),
  ]);

  assert.deepEqual(await reg.lookup('claude', 'dup'), { paneId: 'w3:p2', mux: 'herdr', status: 'working' });
});

test('composite lookup: a registry that throws does not hide the other one', async () => {
  const broken: DeskRegistry = {
    async lookup() { throw new Error('herdr server down'); },
    async list() { throw new Error('herdr server down'); },
  };
  const reg = new CompositeDeskRegistry([broken, fixedRegistry([entry('tmux-one', 'tmux', '%7')])]);

  assert.equal((await reg.lookup('claude', 'tmux-one'))?.paneId, '%7');
  assert.deepEqual((await reg.list()).map((e) => e.sessionId), ['tmux-one']);
});

test('composite list: merges both multiplexers and de-duplicates', async () => {
  const reg = new CompositeDeskRegistry([
    fixedRegistry([entry('dup', 'herdr', 'w3:p2'), entry('herdr-only', 'herdr', 'w3:p1')]),
    fixedRegistry([entry('dup', 'tmux', '%7'), entry('tmux-only', 'tmux', '%9')]),
  ]);

  const entries = await reg.list();
  assert.deepEqual(entries.map((e) => e.sessionId), ['dup', 'herdr-only', 'tmux-only']);
  assert.equal(entries[0].target.mux, 'herdr');
});

test('defaultDeskRegistry: consults both multiplexers regardless of the configured one', async () => {
  // Reachability is about where the user actually started their agent, not
  // about how termcast spawns phone terminals.
  const reg = defaultDeskRegistry();
  assert.ok(reg instanceof CompositeDeskRegistry);
});

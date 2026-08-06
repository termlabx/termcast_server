import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionLiveness } from './session-liveness.js';
import type { LiveSession } from './session-registry.js';

const liveSession = (over: Partial<LiveSession> = {}): LiveSession => ({
  sessionId: 's1', cwd: '/repo', transcriptPath: '/t.jsonl', pid: 1, paneId: null, ...over,
});

test('claude: a session present in the hook registry is alive', async () => {
  const liveness = new SessionLiveness({ liveSessions: () => [liveSession({ sessionId: 's1' })] });
  assert.equal(await liveness.isAlive('claude', 's1', '/repo'), true);
});

test('claude: a session absent from the hook registry is not alive', async () => {
  const liveness = new SessionLiveness({ liveSessions: () => [liveSession({ sessionId: 'other' })] });
  assert.equal(await liveness.isAlive('claude', 's1', '/repo'), false);
});

test('opencode: an opencode process in the session directory means alive', async () => {
  const liveness = new SessionLiveness({
    liveSessions: () => [],
    processes: async () => [{ pid: 42, cwd: '/repo', command: 'opencode' }],
  });
  assert.equal(await liveness.isAlive('opencode', 'ses_1', '/repo'), true);
});

test('opencode: a process in a different directory does not make it alive', async () => {
  const liveness = new SessionLiveness({
    liveSessions: () => [],
    processes: async () => [{ pid: 42, cwd: '/elsewhere', command: 'opencode' }],
  });
  assert.equal(await liveness.isAlive('opencode', 'ses_1', '/repo'), false);
});

test('opencode: a non-opencode process in the directory does not make it alive', async () => {
  const liveness = new SessionLiveness({
    liveSessions: () => [],
    processes: async () => [{ pid: 42, cwd: '/repo', command: 'node server.js' }],
  });
  assert.equal(await liveness.isAlive('opencode', 'ses_1', '/repo'), false);
});

test('opencode: an empty project path never counts as alive', async () => {
  // Guard against matching every process when a summary carries no path.
  const liveness = new SessionLiveness({
    liveSessions: () => [],
    processes: async () => [{ pid: 42, cwd: '', command: 'opencode' }],
  });
  assert.equal(await liveness.isAlive('opencode', 'ses_1', ''), false);
});

test('opencode: a failing process lister reports not alive rather than throwing', async () => {
  const liveness = new SessionLiveness({
    liveSessions: () => [],
    processes: async () => { throw new Error('ps failed'); },
  });
  assert.equal(await liveness.isAlive('opencode', 'ses_1', '/repo'), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionLiveness,
  defaultProcessLister,
  listProcProcesses,
  listPgrepProcesses,
  type ProcFs,
} from './session-liveness.js';
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

// ── /proc scanning ──────────────────────────────────────────────────
// Linux boxes routinely lack lsof (Debian slim, Alpine, most container
// images), and there the pgrep+lsof lister returns "nothing running" — which
// offers a session held by a desk TUI for headless resume. /proc answers the
// same question with no external binary at all.

const procFs = (procs: Record<string, { comm?: string; cwd?: string }>, extraDirs: string[] = []): ProcFs => ({
  readdir: async () => [...Object.keys(procs), ...extraDirs],
  readFile: async (path) => {
    const pid = /^\/proc\/(\d+)\/comm$/.exec(path)?.[1];
    const comm = pid ? procs[pid]?.comm : undefined;
    if (comm === undefined) throw new Error(`ENOENT ${path}`);
    return `${comm}\n`;
  },
  readlink: async (path) => {
    const pid = /^\/proc\/(\d+)\/cwd$/.exec(path)?.[1];
    const cwd = pid ? procs[pid]?.cwd : undefined;
    if (cwd === undefined) throw new Error(`EACCES ${path}`);
    return cwd;
  },
});

test('proc: an opencode process is reported with the cwd its link points at', async () => {
  const procs = await listProcProcesses(procFs({ '42': { comm: 'opencode', cwd: '/repo' } }));
  assert.deepEqual(procs, [{ pid: 42, cwd: '/repo', command: 'opencode' }]);
});

test('proc: processes that are not opencode are left out', async () => {
  const procs = await listProcProcesses(procFs({
    '42': { comm: 'opencode', cwd: '/repo' },
    '43': { comm: 'node', cwd: '/repo' },
  }));
  assert.deepEqual(procs.map((p) => p.pid), [42]);
});

test('proc: non-pid entries in /proc are skipped', async () => {
  // /proc holds self, cpuinfo, sys/… alongside the numeric directories.
  const procs = await listProcProcesses(procFs(
    { '42': { comm: 'opencode', cwd: '/repo' } },
    ['self', 'cpuinfo', 'sys'],
  ));
  assert.deepEqual(procs.map((p) => p.pid), [42]);
});

test('proc: a process that exits mid-scan is skipped, not fatal', async () => {
  const procs = await listProcProcesses(procFs({
    '42': {},                                    // comm read throws: already gone
    '43': { comm: 'opencode', cwd: '/repo' },
  }));
  assert.deepEqual(procs.map((p) => p.pid), [43]);
});

test('proc: another user\'s opencode, whose cwd link is unreadable, is skipped', async () => {
  // Reading /proc/<pid>/cwd of a process we do not own is EACCES. Claiming it
  // runs in *our* project path would hide a session that we could resume.
  const procs = await listProcProcesses(procFs({ '42': { comm: 'opencode' } }));
  assert.deepEqual(procs, []);
});

test('proc: an unreadable /proc reports nothing rather than throwing', async () => {
  const procs = await listProcProcesses({
    readdir: async () => { throw new Error('ENOENT /proc'); },
    readFile: async () => '',
    readlink: async () => '',
  });
  assert.deepEqual(procs, []);
});

test('the default lister reads /proc on Linux and shells out elsewhere', async () => {
  assert.equal(defaultProcessLister('linux'), listProcProcesses);
  assert.equal(defaultProcessLister('darwin'), listPgrepProcesses);
});

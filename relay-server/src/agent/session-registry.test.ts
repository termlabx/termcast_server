import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLiveSessions, markLive, clearLive, applyLiveness } from './session-registry.js';
import type { AgentSessionSummary } from './types.js';

const summary = (id: string): AgentSessionSummary => ({
  id, agent: 'claude', title: 't', projectPath: '/p', lastActiveAt: null,
  isLive: false, messageCount: null, model: null, needsAttention: false,
});

test('markLive then readLiveSessions round-trips an entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-'));

  markLive(dir, { sessionId: 's1', cwd: '/repo', transcriptPath: '/t.jsonl', pid: process.pid, paneId: null });

  const live = readLiveSessions(dir);
  assert.equal(live.length, 1);
  assert.equal(live[0].sessionId, 's1');
});

test('readLiveSessions: an entry whose pid is gone is treated as dead', () => {
  // A crashed agent leaves its file behind; without the pid check the session
  // would show a live badge forever.
  const dir = mkdtempSync(join(tmpdir(), 'live-'));
  markLive(dir, { sessionId: 'dead', cwd: '/repo', transcriptPath: '/t.jsonl', pid: 2_147_483_600, paneId: null });

  assert.deepEqual(readLiveSessions(dir), []);
});

test('readLiveSessions: a corrupt entry is skipped, not fatal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-'));
  writeFileSync(join(dir, 'broken.json'), '{not json');
  markLive(dir, { sessionId: 'ok', cwd: '/repo', transcriptPath: '/t.jsonl', pid: process.pid, paneId: null });

  assert.deepEqual(readLiveSessions(dir).map((e) => e.sessionId), ['ok']);
});

test('readLiveSessions: a missing directory yields no entries', () => {
  assert.deepEqual(readLiveSessions(join(tmpdir(), 'not-here-4a2b')), []);
});

test('clearLive: removes the entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-'));
  markLive(dir, { sessionId: 's1', cwd: '/repo', transcriptPath: '/t.jsonl', pid: process.pid, paneId: null });

  clearLive(dir, 's1');

  assert.deepEqual(readLiveSessions(dir), []);
});

test('applyLiveness: flags only the sessions that are actually live', () => {
  const sessions = [summary('s1'), summary('s2')];

  const flagged = applyLiveness(sessions, [
    { sessionId: 's2', cwd: '/repo', transcriptPath: '/t.jsonl', pid: process.pid, paneId: null },
  ]);

  assert.equal(flagged.find((s) => s.id === 's1')?.isLive, false);
  assert.equal(flagged.find((s) => s.id === 's2')?.isLive, true);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { collectSessions, truncate, ACTIVE_WINDOW_MS } from './ai-metrics';
import { aiMetricsHtml } from './ai-metrics-html';

const NO_DB = join(tmpdir(), 'no-such-opencode-xyz.db');

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ai-metrics-'));
}

const CLAUDE_TRANSCRIPT = [
  '{"type":"last-prompt","leafUuid":"x","sessionId":"abc123"}',
  '{"type":"user","message":{"role":"user","content":"implement the AI metrics popup"},"cwd":"/tmp/proj","timestamp":"2026-08-01T00:00:00.000Z","origin":{"kind":"human"}}',
  '{"type":"assistant","model":"claude-opus-5","timestamp":"2026-08-01T00:00:01.000Z","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":200,"cache_creation_input_tokens":10}}',
  '{"type":"assistant","model":"claude-opus-5","timestamp":"2026-08-01T00:00:02.000Z","usage":{"input_tokens":300,"output_tokens":60}}',
  '{"type":"assistant","model":"claude-sonnet-5","timestamp":"2026-08-01T00:00:03.000Z","usage":{"input_tokens":10,"output_tokens":5}}',
].join('\n');

test('collectSessions: parses a Claude Code transcript into a session', async () => {
  const dir = tempDir();
  const projectDir = join(dir, '-Users-xingwang-Projects-app');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'abc123.jsonl'), CLAUDE_TRANSCRIPT);
  const updatedAt = statSync(join(projectDir, 'abc123.jsonl')).mtimeMs;

  const sessions = await collectSessions({ claudeProjectsDir: dir, opencodeDbPath: NO_DB, now: updatedAt + 5000 });
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.source, 'claude-code');
  assert.equal(s.id, 'abc123');
  assert.equal(s.topic, 'implement the AI metrics popup');
  assert.equal(s.project, '/tmp/proj');
  assert.equal(s.active, true);
  assert.equal(s.currentModel, 'claude-sonnet-5');
  assert.equal(s.tokens.input, 410);
  assert.equal(s.tokens.output, 115);
  assert.equal(s.tokens.cacheRead, 200);
  assert.equal(s.tokens.cacheWrite, 10);
  assert.deepEqual(s.modelTrace.map(m => m.model), ['claude-opus-5', 'claude-sonnet-5']);
  assert.deepEqual(s.modelTrace.map(m => m.messages), [2, 1]);
});

test('collectSessions: a session untouched for a while is inactive', async () => {
  const dir = tempDir();
  const projectDir = join(dir, '-Users-xingwang-Projects-app');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'abc123.jsonl'), CLAUDE_TRANSCRIPT);
  const updatedAt = statSync(join(projectDir, 'abc123.jsonl')).mtimeMs;

  const sessions = await collectSessions({ claudeProjectsDir: dir, opencodeDbPath: NO_DB, now: updatedAt + ACTIVE_WINDOW_MS + 60_000 });
  assert.equal(sessions[0].active, false);
});

test('collectSessions: claude scan skips memory dirs and non-jsonl files', async () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'memory'), { recursive: true });
  mkdirSync(join(dir, 'some-project'), { recursive: true });
  writeFileSync(join(dir, 'some-project', 'notes.txt'), 'not a session');
  writeFileSync(join(dir, 'some-project', 'xyz.jsonl'), CLAUDE_TRANSCRIPT);

  const sessions = await collectSessions({ claudeProjectsDir: dir, opencodeDbPath: NO_DB, now: Date.now() });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'xyz');
});

test('collectSessions: missing claude dir yields no claude sessions', async () => {
  const sessions = await collectSessions({ claudeProjectsDir: join(tmpdir(), 'does-not-exist-xyz'), opencodeDbPath: NO_DB, now: Date.now() });
  assert.deepEqual(sessions, []);
});

function makeOpencodeDb(dbPath: string, now: number): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY,
    project_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT,
    cost REAL DEFAULT 0,
    tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0,
    tokens_reasoning INTEGER DEFAULT 0, tokens_cache_read INTEGER DEFAULT 0, tokens_cache_write INTEGER DEFAULT 0,
    model TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER
  )`);
  db.exec(`CREATE TABLE message (
    id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT
  )`);
  db.prepare(
    `INSERT INTO session (id, directory, title, agent, model, cost,
       tokens_input, tokens_output, tokens_cache_read, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'ses_1', '/work/app', 'Fix the frobnicator', 'build',
    '{"id":"deepseek-v4-flash-free","providerID":"opencode"}', 0.0123,
    1000, 500, 60, now - 1000, now - 5000,
  );
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`).run(
    'msg_a', 'ses_1', now - 4000, now - 4000,
    JSON.stringify({ role: 'assistant', modelID: 'big-pickle', providerID: 'opencode', tokens: { input: 400, output: 200, cache: { read: 50, write: 10 } } }),
  );
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`).run(
    'msg_b', 'ses_1', now - 3000, now - 3000,
    JSON.stringify({ role: 'assistant', modelID: 'deepseek-v4-flash-free', providerID: 'opencode', tokens: { input: 600, output: 300, cache: { read: 10, write: 0 } } }),
  );
  db.close();
}

test('collectSessions: reads opencode sessions from sqlite', async () => {
  const dir = tempDir();
  const dbPath = join(dir, 'opencode.db');
  const now = Date.now();
  makeOpencodeDb(dbPath, now);

  const sessions = await collectSessions({ claudeProjectsDir: join(tmpdir(), 'no-such-claude-xyz'), opencodeDbPath: dbPath, now });
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.source, 'opencode');
  assert.equal(s.id, 'ses_1');
  assert.equal(s.topic, 'Fix the frobnicator');
  assert.equal(s.project, '/work/app');
  assert.equal(s.agent, 'build');
  assert.equal(s.currentModel, 'deepseek-v4-flash-free');
  assert.equal(s.active, true);
  assert.equal(s.cost, 0.0123);
  assert.equal(s.tokens.input, 1000);
  assert.equal(s.tokens.output, 500);
  const trace = s.modelTrace.find(m => m.model === 'deepseek-v4-flash-free');
  assert.ok(trace);
  assert.equal(trace.messages, 1);
  assert.equal(trace.inputTokens, 600);
  assert.equal(trace.outputTokens, 300);
  const trace2 = s.modelTrace.find(m => m.model === 'big-pickle');
  assert.ok(trace2);
  assert.equal(trace2.cacheReadTokens, 50);
});

test('collectSessions: missing opencode db yields no opencode sessions', async () => {
  const sessions = await collectSessions({ claudeProjectsDir: join(tmpdir(), 'no-such-claude-xyz'), opencodeDbPath: join(tmpdir(), 'nope.db'), now: Date.now() });
  assert.deepEqual(sessions, []);
});

test('truncate: keeps short text and ellipsizes long text', () => {
  assert.equal(truncate('short'), 'short');
  assert.equal(truncate('a'.repeat(200), 160).endsWith('…'), true);
});

test('aiMetricsHtml: embeds the session list and escapes script-breaking text', () => {
  const dir = tempDir();
  const projectDir = join(dir, '-proj');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 's1.jsonl'), CLAUDE_TRANSCRIPT);
  const now = Date.now();

  return collectSessions({ claudeProjectsDir: dir, opencodeDbPath: NO_DB, now }).then(sessions => {
    sessions[0].topic = 'topic </script><script>alert(1)</script>';
    const html = aiMetricsHtml(sessions);
    assert.ok(html.includes('AI Metrics'));
    assert.ok(html.includes('topic \\u003c/script>'));
    assert.ok(!html.includes('</script><script>alert'));
  });
});

test('aiMetricsHtml: empty list renders a page (no crash)', () => {
  const html = aiMetricsHtml([]);
  assert.ok(html.includes('AI Metrics'));
  assert.ok(html.includes('No sessions'));
});

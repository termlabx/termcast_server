import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { collectSessions, collectUsage, truncate, ACTIVE_WINDOW_MS } from './ai-metrics';
import { summarize } from './ai-usage';
import { aiMetricsHtml } from './ai-metrics-html';

const NO_DB = join(tmpdir(), 'no-such-opencode-xyz.db');

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ai-metrics-'));
}

// Real Claude Code shape: model/usage live under message, and every content
// block of one response repeats the same message.id.
const CLAUDE_TRANSCRIPT = [
  '{"type":"last-prompt","leafUuid":"x","sessionId":"abc123"}',
  '{"type":"user","message":{"role":"user","content":"implement the AI metrics popup"},"cwd":"/tmp/proj","timestamp":"2026-08-01T00:00:00.000Z","origin":{"kind":"human"}}',
  '{"type":"assistant","message":{"id":"msg_1","model":"claude-opus-5","stop_reason":"end_turn","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":200,"cache_creation_input_tokens":10,"cache_creation":{"ephemeral_1h_input_tokens":10}}},"requestId":"req_1","timestamp":"2026-08-01T00:00:01.000Z"}',
  '{"type":"assistant","message":{"id":"msg_1","model":"claude-opus-5","stop_reason":"end_turn","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":200,"cache_creation_input_tokens":10}},"requestId":"req_1","timestamp":"2026-08-01T00:00:02.000Z"}',
  '{"type":"assistant","message":{"id":"msg_2","model":"claude-sonnet-5","stop_reason":"tool_use","usage":{"input_tokens":10,"output_tokens":5}},"requestId":"req_2","timestamp":"2026-08-01T00:00:03.000Z"}',
].join('\n');

// Old top-level shape; must still parse via the fallback.
const LEGACY_TRANSCRIPT = [
  '{"type":"user","message":{"role":"user","content":"legacy shape"},"cwd":"/tmp/p","timestamp":"2026-08-01T00:00:00.000Z"}',
  '{"type":"assistant","model":"claude-opus-5","timestamp":"2026-08-01T00:00:01.000Z","usage":{"input_tokens":7,"output_tokens":3}}',
].join('\n');

function writeClaude(projectName: string, name: string, transcript: string): string {
  const dir = tempDir();
  const projectDir = join(dir, projectName);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, name), transcript);
  return dir;
}

test('collectSessions: parses a Claude Code transcript into a session', async () => {
  const dir = writeClaude('-Users-xingwang-Projects-app', 'abc123.jsonl', CLAUDE_TRANSCRIPT);
  const updatedAt = statSync(join(dir, '-Users-xingwang-Projects-app', 'abc123.jsonl')).mtimeMs;

  const sessions = await collectSessions({ claudeProjectsDir: dir, opencodeDbPath: NO_DB, now: updatedAt + 5000 });
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.source, 'claude-code');
  assert.equal(s.id, 'abc123');
  assert.equal(s.topic, 'implement the AI metrics popup');
  assert.equal(s.project, '/tmp/proj');
  assert.equal(s.active, true);
  assert.equal(s.currentModel, 'claude-sonnet-5');
  assert.equal(s.tokens.input, 110);
  assert.equal(s.tokens.output, 55);
  assert.equal(s.tokens.cacheRead, 200);
  assert.equal(s.tokens.cacheWrite, 10);
  assert.deepEqual(s.modelTrace.map(m => m.model), ['claude-opus-5', 'claude-sonnet-5']);
  assert.deepEqual(s.modelTrace.map(m => m.messages), [1, 1]);
});

test('collectUsage: reads usage from message.usage and dedupes by message.id', async () => {
  const dir = writeClaude('-proj', 'abc123.jsonl', CLAUDE_TRANSCRIPT);
  const { sessions, records } = await collectUsage({ claudeProjectsDir: dir, opencodeDbPath: NO_DB, now: Date.now() });
  assert.equal(records.length, 2);
  assert.equal(records[0].source, 'claude-code');
  assert.equal(records[0].model, 'claude-opus-5');
  assert.equal(records[0].input, 100);
  assert.equal(records[0].output, 50);
  assert.equal(records[0].cacheWrite, 10);
  assert.equal(records[0].cacheTtlMs, 3_600_000);
  assert.equal(records[0].stopReason, 'end_turn');
  assert.equal(records[1].model, 'claude-sonnet-5');
  assert.equal(records[1].cacheTtlMs, 0);
  assert.equal(records[1].stopReason, 'tool_use');
  assert.equal(sessions[0].tokens.input, 110);
});

test('collectUsage: legacy top-level usage shape still parses', async () => {
  const dir = writeClaude('-proj', 'legacy.jsonl', LEGACY_TRANSCRIPT);
  const { sessions, records } = await collectUsage({ claudeProjectsDir: dir, opencodeDbPath: NO_DB, now: Date.now() });
  assert.equal(records.length, 1);
  assert.equal(records[0].model, 'claude-opus-5');
  assert.equal(records[0].input, 7);
  assert.equal(sessions[0].tokens.input, 7);
});

test('collectSessions: a session untouched for a while is inactive', async () => {
  const dir = writeClaude('-Users-xingwang-Projects-app', 'abc123.jsonl', CLAUDE_TRANSCRIPT);
  const updatedAt = statSync(join(dir, '-Users-xingwang-Projects-app', 'abc123.jsonl')).mtimeMs;

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

test('collectUsage: scans more than 25 transcripts per project', async () => {
  const dir = tempDir();
  const projectDir = join(dir, '-proj');
  mkdirSync(projectDir, { recursive: true });
  for (let i = 0; i < 30; i++) {
    writeFileSync(join(projectDir, `s${String(i).padStart(3, '0')}.jsonl`), CLAUDE_TRANSCRIPT);
  }
  const { sessions } = await collectUsage({ claudeProjectsDir: dir, opencodeDbPath: NO_DB, now: Date.now() });
  assert.equal(sessions.length, 30);
});

test('collectUsage: marks an assistant interrupted by the next user record', async () => {
  const transcript = [
    '{"type":"user","message":{"role":"user","content":"do something"},"timestamp":"2026-08-01T00:00:00.000Z"}',
    '{"type":"assistant","message":{"id":"m1","model":"claude-opus-5","usage":{"input_tokens":10,"output_tokens":20}},"timestamp":"2026-08-01T00:00:01.000Z"}',
    '{"type":"user","message":{"role":"user","content":"Request interrupted by user"},"timestamp":"2026-08-01T00:00:02.000Z"}',
  ].join('\n');
  const dir = writeClaude('-proj', 'int.jsonl', transcript);
  const { records } = await collectUsage({ claudeProjectsDir: dir, opencodeDbPath: NO_DB, now: Date.now() });
  assert.equal(records.length, 1);
  assert.equal(records[0].interrupted, true);
});

test('collectUsage: a plain follow-up user record does not mark interrupted', async () => {
  const transcript = [
    '{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-08-01T00:00:00.000Z"}',
    '{"type":"assistant","message":{"id":"m1","model":"claude-opus-5","usage":{"input_tokens":10,"output_tokens":20}},"timestamp":"2026-08-01T00:00:01.000Z"}',
    '{"type":"user","message":{"role":"user","content":"actually keep going"},"timestamp":"2026-08-01T00:00:02.000Z"}',
  ].join('\n');
  const dir = writeClaude('-proj', 'plain.jsonl', transcript);
  const { records } = await collectUsage({ claudeProjectsDir: dir, opencodeDbPath: NO_DB, now: Date.now() });
  assert.equal(records.length, 1);
  assert.equal(records[0].interrupted, undefined);
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

function makeOpencodeDbWithSessionMessages(dbPath: string, now: number): void {
  makeOpencodeDb(dbPath, now);
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, time_updated INTEGER, data TEXT
  )`);
  db.prepare(`INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`).run(
    'msg_a', 'ses_1', 'assistant', now - 4000, now - 4000,
    JSON.stringify({ model: { id: 'big-pickle', providerID: 'opencode' }, tokens: { input: 999, output: 999, cache: { read: 1, write: 1 } } }),
  );
  db.prepare(`INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`).run(
    'msg_new', 'ses_1', 'assistant', now - 2000, now - 2000,
    JSON.stringify({ model: { id: 'gpt-5-mini', providerID: 'openai' }, finish: 'length', tokens: { input: 50, output: 60, cache: { read: 0, write: 0 } } }),
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

test('collectUsage: missing opencode db yields no opencode sessions', async () => {
  const { sessions } = await collectUsage({ claudeProjectsDir: join(tmpdir(), 'no-such-claude-xyz'), opencodeDbPath: join(tmpdir(), 'nope.db'), now: Date.now() });
  assert.deepEqual(sessions, []);
});

test('collectUsage: opencode db lacking session_message table still yields legacy sessions', async () => {
  const dir = tempDir();
  const dbPath = join(dir, 'opencode.db');
  const now = Date.now();
  makeOpencodeDb(dbPath, now);

  const { sessions, records } = await collectUsage({ claudeProjectsDir: join(tmpdir(), 'no-such-claude-xyz'), opencodeDbPath: dbPath, now });
  assert.equal(sessions.length, 1);
  assert.equal(records.length, 2);
});

test('collectUsage: collects session_message rows and dedupes with message rows', async () => {
  const dir = tempDir();
  const dbPath = join(dir, 'opencode.db');
  const now = Date.now();
  makeOpencodeDbWithSessionMessages(dbPath, now);

  const { sessions, records } = await collectUsage({ claudeProjectsDir: join(tmpdir(), 'no-such-claude-xyz'), opencodeDbPath: dbPath, now });
  assert.equal(records.length, 3);
  const msgNew = records.find(r => r.model === 'openai/gpt-5-mini');
  assert.ok(msgNew);
  assert.equal(msgNew.input, 50);
  assert.equal(msgNew.output, 60);
  assert.equal(msgNew.stopReason, 'max_tokens');
  const bp = records.filter(r => r.model === 'big-pickle');
  assert.equal(bp.length, 1);
  assert.equal(bp[0].input, 400);
  assert.ok(sessions[0].modelTrace.find(m => m.model === 'openai/gpt-5-mini'));
});

test('truncate: keeps short text and ellipsizes long text', () => {
  assert.equal(truncate('short'), 'short');
  assert.equal(truncate('a'.repeat(200), 160).endsWith('…'), true);
});

test('aiMetricsHtml: embeds the session list and escapes script-breaking text', async () => {
  const dir = writeClaude('-proj', 's1.jsonl', CLAUDE_TRANSCRIPT);
  const now = Date.now();
  const { sessions, records } = await collectUsage({ claudeProjectsDir: dir, opencodeDbPath: NO_DB, now });
  sessions[0].topic = 'topic </script><script>alert(1)</script>';
  const usage = summarize(records, { now, days: 30, timeZone: 'UTC' });
  const html = aiMetricsHtml(sessions, usage);
  assert.ok(html.includes('AI Metrics'));
  assert.ok(html.includes('topic \\u003c/script>'));
  assert.ok(!html.includes('</script><script>alert'));
});

test('aiMetricsHtml: renders tabs, a 30-bar chart, and the waste table', () => {
  const now = Date.parse('2026-08-03T12:00:00Z');
  const records = [
    { source: 'claude-code', sessionId: 's1', model: 'm', at: Date.parse('2026-08-03T10:00:00Z'), day: '2026-08-03', input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cacheTtlMs: 3_600_000 },
    { source: 'claude-code', sessionId: 's2', model: 'm', at: Date.parse('2026-08-01T10:00:00Z'), day: '2026-08-01', input: 5, output: 5, cacheRead: 0, cacheWrite: 5, cacheTtlMs: 300_000, interrupted: true },
    { source: 'claude-code', sessionId: 's3', model: 'm', at: Date.parse('2026-08-02T10:00:00Z'), day: '2026-08-02', input: 1, output: 100, cacheRead: 0, cacheWrite: 0, cacheTtlMs: 3_600_000, stopReason: 'max_tokens' },
  ];
  const usage = summarize(records, { now, days: 30, timeZone: 'UTC' });
  const html = aiMetricsHtml([], usage);
  assert.ok(html.includes('id="usageTab"'));
  assert.ok(html.includes('id="sessionsTab"'));
  assert.ok(html.includes('id="chartNoReads"'));
  assert.ok(html.includes('id="chartReads"'));
  assert.equal((html.match(/class="day"/g) || []).length, 60);
  assert.ok(html.includes('Expired cache writes'));
  assert.ok(html.includes('Interrupted turns'));
  assert.ok(html.includes('Truncated responses'));
  assert.ok(html.includes('TODAY'));
  assert.ok(html.includes('CACHE WASTED'));
});

test('aiMetricsHtml: empty usage renders its empty state', () => {
  const now = Date.parse('2026-08-03T12:00:00Z');
  const usage = summarize([], { now, days: 30, timeZone: 'UTC' });
  const html = aiMetricsHtml([], usage);
  assert.ok(html.includes('AI Metrics'));
  assert.ok(html.includes('No usage recorded yet'));
  assert.ok(html.includes('No sessions'));
});

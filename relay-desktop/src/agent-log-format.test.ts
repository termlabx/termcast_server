import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAgentLogRow } from './agent-log-format.js';

const at = '2026-08-05T21:04:05.123Z';

test('renders a phone→server send with its text', () => {
  const row = formatAgentLogRow({
    timestamp: at, direction: 'in', connId: 1, agent: 'opencode', sessionId: 'ses_abc123456',
    type: 'send', text: 'deploy the app',
  });
  assert.equal(row.direction, 'in');
  assert.equal(row.type, 'send');
  assert.equal(row.scope, 'opencode ses_abc12345…');
  assert.equal(row.detail, '"deploy the app"');
  assert.match(row.time, /^\d{2}:\d{2}:\d{2}\.\d{3}$/);
});

test('renders a status error with its detail', () => {
  const row = formatAgentLogRow({
    timestamp: at, direction: 'out', sessionId: 's1', type: 'status',
    value: 'error', detail: 'transcript read failed: gone',
  });
  assert.equal(row.type, 'status error');
  assert.equal(row.detail, 'transcript read failed: gone');
});

test('renders a plain status without duplicating the type', () => {
  const row = formatAgentLogRow({ timestamp: at, direction: 'out', sessionId: 's1', type: 'status', value: 'turn_start' });
  assert.equal(row.type, 'status turn_start');
  assert.equal(row.detail, '');
});

test('renders a question with its prompt', () => {
  const row = formatAgentLogRow({ timestamp: at, direction: 'out', type: 'question', requestId: 'q1', prompt: 'Pick one' });
  assert.equal(row.detail, 'q1 "Pick one"');
});

test('renders an answered question with its answers', () => {
  const row = formatAgentLogRow({ timestamp: at, direction: 'in', type: 'question', requestId: 'q1', answers: ['a', 'ship it'] });
  assert.equal(row.detail, 'q1 ["a","ship it"]');
});

test('renders a rejected question', () => {
  const row = formatAgentLogRow({ timestamp: at, direction: 'in', type: 'question', requestId: 'q1', rejected: true });
  assert.equal(row.detail, 'q1 rejected');
});

test('renders an attach decision target', () => {
  const row = formatAgentLogRow({ timestamp: at, direction: 'in', connId: 2, type: 'attach-terminal', target: 'herdr:work', mux: 'herdr' });
  assert.equal(row.detail, 'herdr:work (herdr)');
});

test('renders history paging bounds', () => {
  const row = formatAgentLogRow({ timestamp: at, direction: 'in', sessionId: 's1', type: 'history', beforeSeq: null, limit: 50 });
  assert.equal(row.detail, 'beforeSeq=null limit=50');
});

test('renders a history reply count', () => {
  const row = formatAgentLogRow({ timestamp: at, direction: 'out', sessionId: 's1', type: 'history', count: 12 });
  assert.equal(row.detail, 'count=12');
});

test('truncates a very long text so one row cannot flood the window', () => {
  const row = formatAgentLogRow({ timestamp: at, direction: 'in', type: 'send', text: 'x'.repeat(400) });
  assert.ok(row.detail.length < 320, `expected truncation, got ${row.detail.length} chars`);
  assert.ok(row.detail.endsWith('…"'), row.detail.slice(-10));
});

test('falls back to the conn id when there is no session', () => {
  const row = formatAgentLogRow({ timestamp: at, direction: 'in', connId: 3, type: 'list' });
  assert.equal(row.scope, 'conn 3');
});

test('searchable text folds every rendered part together', () => {
  const row = formatAgentLogRow({
    timestamp: at, direction: 'in', connId: 1, agent: 'claude', sessionId: 's1', type: 'send', text: 'Deploy',
  });
  assert.ok(row.search.includes('deploy'));
  assert.ok(row.search.includes('claude'));
  assert.ok(row.search.includes('send'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLogRing } from './agent-log.js';

const at = (iso: string) => new Date(iso);

test('records are numbered from 1 so a poller can ask for what it has not seen', () => {
  const ring = new AgentLogRing(10);
  ring.record('->', { conn: 1, type: 'list' });
  ring.record('<-', { conn: 1, type: 'sessions', count: 3 });
  assert.deepEqual(ring.rows().map((r) => r.seq), [1, 2]);
});

test('rowsSince returns only what came after the caller\'s last seq', () => {
  const ring = new AgentLogRing(10);
  ring.record('->', { conn: 1, type: 'list' });
  ring.record('->', { conn: 1, type: 'detach' });
  const rows = ring.rowsSince(1);
  assert.deepEqual(rows.map((r) => r.type), ['detach']);
});

test('the ring drops the oldest rows but never renumbers the survivors', () => {
  // A poller holds a seq across refreshes; renumbering would replay old rows
  // as if they were new.
  const ring = new AgentLogRing(2);
  ring.record('->', { conn: 1, type: 'one' });
  ring.record('->', { conn: 1, type: 'two' });
  ring.record('->', { conn: 1, type: 'three' });
  assert.deepEqual(ring.rows().map((r) => [r.seq, r.type]), [[2, 'two'], [3, 'three']]);
});

test('-> is traffic from the phone and <- traffic back to it', () => {
  const ring = new AgentLogRing(10);
  ring.record('->', { conn: 1, type: 'send' });
  ring.record('<-', { conn: 1, type: 'event' });
  assert.deepEqual(ring.rows().map((r) => r.direction), ['in', 'out']);
});

test('the scope column names the agent and a shortened session', () => {
  const ring = new AgentLogRing(10);
  ring.record('->', { conn: 1, agent: 'claude', session: 'abcdefghijklmnopqrst', type: 'send' });
  assert.equal(ring.rows()[0].scope, 'claude abcdefghijkl…');
});

test('the scope column falls back to the connection when there is no session', () => {
  const ring = new AgentLogRing(10);
  ring.record('->', { conn: 4, type: 'list' });
  assert.equal(ring.rows()[0].scope, 'conn 4');
});

test('a status frame carries its value in the type column', () => {
  // "status" alone says nothing; turn_start / turn_end is what a reader scans for.
  const ring = new AgentLogRing(10);
  ring.record('<-', { conn: 1, agent: 'claude', session: 's1', type: 'status', value: 'turn_start' });
  assert.equal(ring.rows()[0].type, 'status turn_start');
});

test('message text is quoted and clipped so one row cannot swallow the view', () => {
  const ring = new AgentLogRing(10);
  ring.record('->', { conn: 1, type: 'send', text: 'x'.repeat(400) });
  const { detail } = ring.rows()[0];
  assert.equal(detail.startsWith('"xxx'), true);
  assert.equal(detail.endsWith('…"'), true);
  assert.equal(detail.length < 300, true);
});

test('question answers, permission behavior and the seq fields all reach the detail column', () => {
  const ring = new AgentLogRing(10);
  ring.record('->', { conn: 1, type: 'question', requestId: 'r1', answers: ['Yes, do it', 'b'] });
  ring.record('->', { conn: 1, type: 'permission', requestId: 'r2', behavior: 'allow' });
  ring.record('->', { conn: 1, type: 'history', beforeSeq: null, limit: 50 });
  const [question, permission, history] = ring.rows();
  assert.equal(question.detail, 'r1 ["Yes, do it","b"]');
  assert.equal(permission.detail, 'r2 allow');
  assert.equal(history.detail, 'beforeSeq=null limit=50');
});

test('a rejected question says so rather than showing an empty answer list', () => {
  const ring = new AgentLogRing(10);
  ring.record('->', { conn: 1, type: 'question', requestId: 'r1', rejected: true });
  assert.equal(ring.rows()[0].detail, 'r1 rejected');
});

test('the time column is local wall-clock with milliseconds', () => {
  const ring = new AgentLogRing(10);
  const when = at('2026-08-08T04:05:06.078Z');
  ring.record('->', { conn: 1, type: 'list' }, when);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const expected = `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}.078`;
  assert.equal(ring.rows()[0].time, expected);
});

test('the search column folds every visible part to lowercase', () => {
  const ring = new AgentLogRing(10);
  ring.record('->', { conn: 1, agent: 'claude', session: 's1', type: 'send', text: 'Deploy IT' });
  assert.equal(ring.rows()[0].search, 'claude s1 send "deploy it"');
});

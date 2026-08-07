import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentLogEvents } from './server-agent-log-parser.js';
import { AgentLogRing } from './agent-log-ring.js';

test('parses a phone→server send frame', () => {
  const [ev] = parseAgentLogEvents('[agent] -> conn=1 agent=opencode session=s1 type=send text="deploy the app"');
  assert.equal(ev.direction, 'in');
  assert.equal(ev.connId, 1);
  assert.equal(ev.agent, 'opencode');
  assert.equal(ev.sessionId, 's1');
  assert.equal(ev.type, 'send');
  assert.equal(ev.text, 'deploy the app');
});

test('parses a server→phone status error', () => {
  const [ev] = parseAgentLogEvents('[agent] <- conn=1 session=s1 type=status value=error detail="transcript read failed: gone"');
  assert.equal(ev.direction, 'out');
  assert.equal(ev.type, 'status');
  assert.equal(ev.value, 'error');
  assert.equal(ev.detail, 'transcript read failed: gone');
});

test('parses an answers array, including entries with spaces', () => {
  const [ev] = parseAgentLogEvents('[agent] -> conn=1 type=question requestId=q1 answers=["a","ship it"]');
  assert.deepEqual(ev.answers, ['a', 'ship it']);
});

test('parses an attach decision line', () => {
  const [ev] = parseAgentLogEvents('[attach] conn=1 target=herdr:work mux=herdr');
  assert.equal(ev.type, 'attach-terminal');
  assert.equal(ev.target, 'herdr:work');
  assert.equal(ev.mux, 'herdr');
});

test('parses a null beforeSeq', () => {
  const [ev] = parseAgentLogEvents('[agent] -> conn=1 session=s1 type=history beforeSeq=null limit=50');
  assert.equal(ev.beforeSeq, null);
  assert.equal(ev.limit, 50);
});

test('keeps a quoted value that contains an = sign intact', () => {
  const [ev] = parseAgentLogEvents('[agent] -> conn=1 type=send text="a=b c=d"');
  assert.equal(ev.text, 'a=b c=d');
});

test('unescapes quotes inside a quoted value', () => {
  const [ev] = parseAgentLogEvents('[agent] -> conn=1 type=send text="say \\"hi\\" now"');
  assert.equal(ev.text, 'say "hi" now');
});

test('ignores non-agent lines', () => {
  assert.deepEqual(parseAgentLogEvents('Client connected [id=1]'), []);
});

test('handles a multi-line chunk', () => {
  const events = parseAgentLogEvents(
    '[agent] -> conn=1 type=list\n[agent] <- conn=1 session=s1 type=status value=turn_start');
  assert.equal(events.length, 2);
});

test('tolerates a carriage return at the end of a line', () => {
  const [ev] = parseAgentLogEvents('[agent] -> conn=1 type=list\r\n');
  assert.equal(ev.type, 'list');
});

test('ring buffer keeps at most max entries', () => {
  const ring = new AgentLogRing(3);
  for (let i = 0; i < 5; i++) ring.push({ timestamp: 't', direction: 'in', type: 'message', seq: i });
  const all = ring.all();
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((e) => e.seq), [2, 3, 4]);
});

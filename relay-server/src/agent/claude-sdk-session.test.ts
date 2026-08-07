import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sdkMessageToBlocks, buildQuestionEvents, askUserQuestionResult } from './claude-sdk-session.js';

test('sdkMessageToBlocks: text content becomes a text block', () => {
  const blocks = sdkMessageToBlocks({ content: [{ type: 'text', text: 'hello' }] });

  assert.deepEqual(blocks, [{ kind: 'text', text: 'hello' }]);
});

test('sdkMessageToBlocks: tool_use becomes a toolUse block with a summary', () => {
  const blocks = sdkMessageToBlocks({
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }],
  });

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'toolUse');
  assert.equal((blocks[0] as { summary: string }).summary, 'npm test');
});

test('sdkMessageToBlocks: an oversized tool input is truncated and flagged', () => {
  const blocks = sdkMessageToBlocks({
    content: [{ type: 'tool_use', id: 't', name: 'Write', input: { content: 'x'.repeat(5000) } }],
  });

  const block = blocks[0] as { input: string; truncated: boolean };
  assert.equal(block.truncated, true);
  assert.equal(block.input.length, 2048);
});

test('sdkMessageToBlocks: empty thinking is dropped rather than rendered blank', () => {
  const blocks = sdkMessageToBlocks({ content: [{ type: 'thinking', thinking: '' }] });

  assert.deepEqual(blocks, []);
});

test('sdkMessageToBlocks: an unknown block type is skipped, not fatal', () => {
  const blocks = sdkMessageToBlocks({
    content: [{ type: 'hologram', spin: 3 }, { type: 'text', text: 'kept' }],
  });

  assert.deepEqual(blocks, [{ kind: 'text', text: 'kept' }]);
});

test('sdkMessageToBlocks: a malformed message yields no blocks rather than throwing', () => {
  assert.deepEqual(sdkMessageToBlocks(null), []);
  assert.deepEqual(sdkMessageToBlocks({}), []);
  assert.deepEqual(sdkMessageToBlocks({ content: 'not an array' }), []);
});

// --- AskUserQuestion -------------------------------------------------------

const CALL = {
  questions: [
    { question: 'Which database?', header: 'DB', multiSelect: false,
      options: [{ label: 'Postgres', description: 'Relational' }, { label: 'SQLite' }] },
    { question: 'Which features?', header: 'Feat', multiSelect: true,
      options: [{ label: 'Auth' }, { label: 'Billing' }] },
  ],
};

test('buildQuestionEvents: one call becomes one question per member, sharing a group id', () => {
  const infos = buildQuestionEvents(CALL, { sessionId: 's1', requestId: 'r1' });

  assert.equal(infos.length, 2);
  assert.equal(infos[0].groupId, infos[1].groupId);
  assert.equal(infos[0].groupCount, 2);
  assert.equal(infos[0].groupIndex, 0);
  assert.equal(infos[1].groupIndex, 1);
  // Distinct ids, or answering one would resolve the other.
  assert.notEqual(infos[0].requestId, infos[1].requestId);
});

test('buildQuestionEvents: multiSelect and descriptions survive to the wire', () => {
  const infos = buildQuestionEvents(CALL, { sessionId: 's1', requestId: 'r1' });

  // Absent rather than false — the phone reads absent as "not multi-select".
  assert.equal(infos[0].multiSelect, undefined);
  assert.equal(infos[1].multiSelect, true);
  assert.equal(infos[0].options[0].description, 'Relational');
  assert.equal(infos[0].kind, 'select');
  assert.equal(infos[0].header, 'DB');
});

// The old code sent `{...input, answer: "a, b"}`, which is not a shape the tool
// reads — so even a correctly displayed question was answered wrongly.
test('askUserQuestionResult: echoes each question with the labels chosen for it', () => {
  const result = askUserQuestionResult(CALL, [['Postgres'], ['Auth', 'Billing']]);

  assert.deepEqual(result, {
    answers: [
      { header: 'DB', question: 'Which database?', selected: ['Postgres'] },
      { header: 'Feat', question: 'Which features?', selected: ['Auth', 'Billing'] },
    ],
  });
});

test('askUserQuestionResult: an unanswered member echoes as an empty selection', () => {
  const result = askUserQuestionResult(CALL, [['Postgres']]);

  assert.deepEqual(result.answers[1].selected, []);
});

test('buildQuestionEvents: a question with no options is freeform', () => {
  const infos = buildQuestionEvents(
    { questions: [{ question: 'Name it?', options: [] }] },
    { sessionId: 's1', requestId: 'r1' },
  );

  assert.equal(infos[0].kind, 'freeform');
  assert.equal(infos[0].allowsOther, true);
});

test('buildQuestionEvents: every question accepts free text alongside its options', () => {
  const infos = buildQuestionEvents(CALL, { sessionId: 's1', requestId: 'r1' });

  // AskUserQuestion always permits an answer that is not on the list.
  assert.equal(infos[0].allowsOther, true);
});

test('buildQuestionEvents: a call with nothing answerable yields no questions', () => {
  assert.deepEqual(buildQuestionEvents({ notAQuestion: true }, { sessionId: 's1', requestId: 'r1' }), []);
});

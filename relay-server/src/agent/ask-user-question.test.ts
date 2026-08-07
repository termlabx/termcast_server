import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAskUserQuestion } from './ask-user-question.js';

/**
 * Shaped after a real call captured from `~/.claude/projects/**.jsonl`
 * (see the Task 1 findings). The `preview` field is genuine and deliberately
 * ignored: it is a multi-line block the desktop renders beside the list, it is
 * why 22% of real inputs blow past the transcript clamp, and a phone card has
 * nowhere to put it.
 */
const REAL_INPUT = {
  questions: [
    {
      question: 'Which database should the new service use?',
      header: 'Database',
      multiSelect: false,
      options: [
        { label: 'Postgres', description: 'Relational, matches the stack', preview: 'CREATE TABLE …' },
        { label: 'SQLite', description: 'Single file, no server' },
      ],
    },
    {
      question: 'Which features do you want enabled?',
      header: 'Features',
      multiSelect: true,
      options: [{ label: 'Auth' }, { label: 'Billing' }],
    },
  ],
};

test('parses every question in the call, preserving multiSelect per question', () => {
  const parsed = parseAskUserQuestion(REAL_INPUT);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].prompt, 'Which database should the new service use?');
  assert.equal(parsed[0].header, 'Database');
  assert.equal(parsed[0].multiSelect, false);
  assert.deepEqual(parsed[0].options[0], {
    label: 'Postgres', description: 'Relational, matches the stack',
  });
  assert.equal(parsed[1].multiSelect, true);
  assert.equal(parsed[1].options[1].label, 'Billing');
  assert.equal(parsed[1].options[0].description, undefined);
});

// The whole bug this module exists to fix: the old reader looked for keys the
// tool never sends, so options came out empty and every question became a text
// box. An empty result must be reachable only for genuinely empty input.
test('returns nothing for input that is not an AskUserQuestion call', () => {
  assert.deepEqual(parseAskUserQuestion({ question: 'legacy shape', options: [] }), []);
  assert.deepEqual(parseAskUserQuestion(null), []);
  assert.deepEqual(parseAskUserQuestion(undefined), []);
  assert.deepEqual(parseAskUserQuestion({ questions: 'not an array' }), []);
});

test('skips malformed members rather than failing the whole call', () => {
  const parsed = parseAskUserQuestion({
    questions: [
      { question: 'Good one', options: [{ label: 'A' }, { label: 'B' }] },
      { header: 'no question text', options: [{ label: 'C' }] },
      { question: 'Options are not objects', options: ['A', 'B'] },
    ],
  });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].prompt, 'Good one');
  // A bare string option is still a usable label; dropping it would lose a choice.
  assert.deepEqual(parsed[1].options.map((o) => o.label), ['A', 'B']);
});

test('a question with no options is a freeform prompt, not a dropped question', () => {
  const parsed = parseAskUserQuestion({ questions: [{ question: 'Name it?', options: [] }] });
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].options, []);
});

test('accepts the JSON string form, which is how the transcript stores it', () => {
  const parsed = parseAskUserQuestion(JSON.parse(JSON.stringify(REAL_INPUT)));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].header, 'Database');
});

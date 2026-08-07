import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correlateDialog } from './desk-correlate.js';
import type { ParsedQuestion } from './ask-user-question.js';
import type { DeskDialog } from './desk-dialog.js';

const structured: ParsedQuestion = {
  prompt: 'Which database should the new service use?',
  header: 'Database',
  multiSelect: false,
  options: [
    { label: 'Postgres, because the rest of the stack already uses it', description: 'Relational' },
    { label: 'SQLite', description: 'Single file' },
  ],
};

function dialog(partial: Partial<DeskDialog>): DeskDialog {
  return {
    prompt: 'Which database should the new service use?',
    kind: 'select',
    input: 'numbered',
    windowed: false,
    fingerprint: 'f',
    options: [],
    ...partial,
  };
}

test('merges descriptions in and carries an absolute index out', () => {
  const merged = correlateDialog(structured, dialog({
    options: [
      // The TUI truncated this label; exact matching would fail here.
      { label: 'Postgres, because the rest of the stack alr…', index: 1, selected: true },
      { label: 'SQLite', index: 2, selected: false },
    ],
  }));

  assert.ok(merged);
  assert.equal(merged.options[0].label, 'Postgres, because the rest of the stack already uses it');
  assert.equal(merged.options[0].description, 'Relational');
  assert.equal(merged.options[0].index, 1);
  assert.equal(merged.options[1].index, 2);
  assert.equal(merged.cursorIndex, 1);
});

// The design's central safety property: a mismatch falls back, it never blends.
test('refuses to merge when the counts disagree', () => {
  assert.equal(correlateDialog(structured, dialog({
    options: [{ label: 'Postgres, because the…', index: 1, selected: true }],
  })), null);
});

test('refuses to merge when a row is not a prefix of its structured label', () => {
  assert.equal(correlateDialog(structured, dialog({
    options: [
      { label: 'Postgres, because the…', index: 1, selected: true },
      { label: 'Something else entirely', index: 2, selected: false },
    ],
  })), null);
});

const long: ParsedQuestion = {
  ...structured,
  options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }],
};

test('refuses a windowed list whose rows are not a contiguous run', () => {
  assert.equal(correlateDialog(long, dialog({
    windowed: true,
    options: [
      { label: 'A', index: 1, selected: true },
      { label: 'C', index: 2, selected: false },
    ],
  })), null);
});

test('merges a windowed list whose rows are a contiguous run, using absolute indices', () => {
  const merged = correlateDialog(long, dialog({
    windowed: true,
    input: 'arrows',
    options: [
      { label: 'B', index: 1, selected: false },
      { label: 'C', index: 2, selected: true },
    ],
  }));

  assert.ok(merged);
  assert.equal(merged.options.length, 4);
  assert.equal(merged.options[0].index, 1);
  assert.equal(merged.options[3].index, 4);
  // The run starts at structured position 2, so the pane's row 2 is really
  // row 3. Walking from the pane's own index would land one row short.
  assert.equal(merged.cursorIndex, 3);
});

test('refuses a freeform dialog, which has no options to line up', () => {
  assert.equal(correlateDialog(structured, dialog({ kind: 'freeform', options: [] })), null);
});

test('refuses when the structured question carries no options', () => {
  assert.equal(correlateDialog({ ...structured, options: [] }, dialog({
    options: [{ label: 'A', index: 1, selected: true }],
  })), null);
});

test('treats an unhighlighted list as sitting on its first row', () => {
  const merged = correlateDialog(structured, dialog({
    options: [
      { label: 'Postgres, because the rest of the stack alr…', index: 1, selected: false },
      { label: 'SQLite', index: 2, selected: false },
    ],
  }));

  assert.ok(merged);
  assert.equal(merged.cursorIndex, 1);
});

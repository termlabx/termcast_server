import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeskDialog } from './desk-dialog.js';

/**
 * Captured verbatim from a real blocked pane (`herdr agent read w3:p2 --source
 * visible`), with the transcript above it shortened. The leading line stands in
 * for everything the agent printed before the dialog — it must never reach the
 * prompt.
 */
const RESUME_DIALOG = [
  '  Some earlier assistant output that must not become the prompt.',
  '',
  '─'.repeat(71),
  '  This session is 1d 1h old and 192.6k tokens.',
  '',
  '  Resuming the full session will consume a substantial portion of your usage limits.',
  '',
  '  ❯ 1. Resume from summary (recommended)',
  '    2. Resume full session as-is',
  "    3. Don't ask me again",
  '',
  '  Enter to confirm · Esc to cancel',
].join('\n');

const ARROW_DIALOG = [
  '─'.repeat(60),
  '  Select Model',
  '',
  '  ❯ Default (recommended)',
  '    Opus',
  '    Sonnet',
  '',
  '  Enter to select · Esc to cancel · ↑/↓ to navigate',
].join('\n');

test('parses a numbered dialog into options and a prompt', () => {
  const dialog = parseDeskDialog(RESUME_DIALOG);
  assert.ok(dialog);
  assert.equal(dialog.kind, 'select');
  assert.equal(dialog.input, 'numbered');
  assert.deepEqual(dialog.options.map((o) => o.label), [
    'Resume from summary (recommended)',
    'Resume full session as-is',
    "Don't ask me again",
  ]);
  assert.deepEqual(dialog.options.map((o) => o.index), [1, 2, 3]);
  assert.equal(dialog.options[0].selected, true);
  assert.equal(dialog.options[1].selected, false);
  assert.match(dialog.prompt, /Resuming the full session/);
  assert.doesNotMatch(dialog.prompt, /earlier assistant output/);
});

test('strips ANSI before matching', () => {
  const coloured = RESUME_DIALOG
    .replace('❯ 1.', '\x1b[1m\x1b[38;5;33m❯\x1b[0m 1.')
    .replace('Esc to cancel', '\x1b[2mEsc to cancel\x1b[0m');
  const dialog = parseDeskDialog(coloured);
  assert.ok(dialog);
  assert.equal(dialog.options.length, 3);
  assert.equal(dialog.options[0].selected, true);
});

test('parses an arrow-key dialog', () => {
  const dialog = parseDeskDialog(ARROW_DIALOG);
  assert.ok(dialog);
  assert.equal(dialog.input, 'arrows');
  assert.equal(dialog.kind, 'select');
  assert.deepEqual(dialog.options.map((o) => o.label), ['Default (recommended)', 'Opus', 'Sonnet']);
  assert.equal(dialog.options[0].selected, true);
  assert.equal(dialog.prompt, 'Select Model');
});

test('drops box-drawing gutters from a boxed permission prompt', () => {
  const rendered = [
    '─'.repeat(60),
    '│  Bash command                            │',
    '│                                          │',
    '│  npm test                                │',
    '│                                          │',
    '│  Do you want to proceed?                 │',
    '│  ❯ 1. Yes                                │',
    '│    2. No, and tell Claude what to do     │',
    '│                                          │',
    '│  Enter to confirm · Esc to cancel        │',
  ].join('\n');
  const dialog = parseDeskDialog(rendered);
  assert.ok(dialog);
  assert.equal(dialog.input, 'numbered');
  assert.deepEqual(dialog.options.map((o) => o.label), ['Yes', 'No, and tell Claude what to do']);
  assert.match(dialog.prompt, /Do you want to proceed\?/);
});

test('emits freeform rather than guessing when no option rows are present', () => {
  const rendered = [
    '─'.repeat(60),
    '  Tell Claude what to do differently:',
    '',
    '  Enter to confirm · Esc to cancel',
  ].join('\n');
  const dialog = parseDeskDialog(rendered);
  assert.ok(dialog);
  assert.equal(dialog.kind, 'freeform');
  assert.equal(dialog.input, 'text');
  assert.deepEqual(dialog.options, []);
  assert.match(dialog.prompt, /Tell Claude what to do differently/);
});

test('returns null when the pane holds no blocker footer', () => {
  assert.equal(parseDeskDialog('  just some output\n  and more output\n'), null);
});

test('returns null when the footer cancels but never confirms', () => {
  // `esc to close` on its own is herdr's /btw overlay, which is working, not
  // blocked. Requiring both halves keeps the parser aligned with the manifest.
  const rendered = ['─'.repeat(40), '  /btw something', '  esc to close'].join('\n');
  assert.equal(parseDeskDialog(rendered), null);
});

test('non-consecutive numbers are not a numbered list', () => {
  const rendered = [
    '─'.repeat(60),
    '  Notes:',
    '  1. first thing',
    '  3. third thing',
    '',
    '  Enter to confirm · Esc to cancel',
  ].join('\n');
  const dialog = parseDeskDialog(rendered);
  assert.ok(dialog);
  assert.equal(dialog.kind, 'freeform');
});

test('fingerprint tracks the dialog and ignores the transcript above it', () => {
  const a = parseDeskDialog(RESUME_DIALOG);
  const b = parseDeskDialog(RESUME_DIALOG.replace('earlier assistant output', 'different output'));
  const c = parseDeskDialog(RESUME_DIALOG.replace('Resume full session as-is', 'Resume everything'));
  assert.ok(a && b && c);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.fingerprint, c.fingerprint);
});

test('only the dialog below the last rule is read', () => {
  // Two dialogs in the visible pane: an answered one still on screen above the
  // rule, and the live one below it. Parsing the wrong one offers a question
  // that no longer exists.
  const rendered = [
    '─'.repeat(60),
    '  Do you want to proceed?',
    '  ❯ 1. Yes',
    '    2. No',
    '  Enter to confirm · Esc to cancel',
    '─'.repeat(60),
    '  Run the tests?',
    '  ❯ 1. Sure',
    '    2. Skip',
    '  Enter to confirm · Esc to cancel',
  ].join('\n');
  const dialog = parseDeskDialog(rendered);
  assert.ok(dialog);
  assert.match(dialog.prompt, /Run the tests\?/);
  assert.deepEqual(dialog.options.map((o) => o.label), ['Sure', 'Skip']);
});

const WINDOWED_DIALOG = [
  '─'.repeat(60),
  '  Select Model',
  '',
  '  ❯ Default (recommended)',
  '    Opus',
  '    Sonnet',
  '  ↓ 3 more',
  '',
  '  Enter to select · Esc to cancel · ↑/↓ to navigate',
].join('\n');

test('marks a list the TUI has scrolled as windowed', () => {
  const dialog = parseDeskDialog(WINDOWED_DIALOG);
  assert.ok(dialog);
  assert.equal(dialog.windowed, true);
  // The scroll hint is chrome, never an option.
  assert.deepEqual(dialog.options.map((o) => o.label),
    ['Default (recommended)', 'Opus', 'Sonnet']);
});

test('an ordinary list is not windowed', () => {
  const dialog = parseDeskDialog(ARROW_DIALOG);
  assert.ok(dialog);
  assert.equal(dialog.windowed, false);
});

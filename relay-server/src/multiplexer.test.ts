import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMultiplexer, sessionNameFor, killSessionCommand, multiplexerFromConfig,
  killCommandsForPhone, describeMultiplexerStatus, sendKeysCommand,
} from './multiplexer.js';

test('killCommandsForPhone: one teardown per real multiplexer, none for none', () => {
  assert.deepEqual(killCommandsForPhone('p1'), [
    "tmux kill-session -t 'tc_p1' 2>/dev/null",
    "herdr session stop 'tch_p1' >/dev/null 2>&1; herdr session delete 'tch_p1' >/dev/null 2>&1",
  ]);
});

test('sessionNameFor: defaults to the tmux namespace when no multiplexer is given', () => {
  assert.equal(sessionNameFor('1A2B-3C4D'), 'tc_1A2B_3C4D');
});

test('parseMultiplexer: defaults to tmux for anything unrecognised', () => {
  assert.equal(parseMultiplexer('herdr'), 'herdr');
  assert.equal(parseMultiplexer('none'), 'none');
  assert.equal(parseMultiplexer('tmux'), 'tmux');
  assert.equal(parseMultiplexer(undefined), 'tmux');
  assert.equal(parseMultiplexer('zellij'), 'tmux');
});

test('sessionNameFor: tmux names are byte-identical to the legacy scheme', () => {
  assert.equal(sessionNameFor('ABC-123.xyz', 'tmux'), 'tc_ABC_123_xyz');
});

test('sessionNameFor: herdr uses a separate namespace so switching keeps both', () => {
  assert.equal(sessionNameFor('ABC-123.xyz', 'herdr'), 'tch_ABC_123_xyz');
  assert.notEqual(sessionNameFor('p', 'herdr'), sessionNameFor('p', 'tmux'));
});

test('killSessionCommand: per-multiplexer teardown, nothing to kill for none', () => {
  assert.equal(killSessionCommand('tc_p', 'tmux'), "tmux kill-session -t 'tc_p' 2>/dev/null");
  assert.equal(
    killSessionCommand('tch_p', 'herdr'),
    "herdr session stop 'tch_p' >/dev/null 2>&1; herdr session delete 'tch_p' >/dev/null 2>&1",
  );
  assert.equal(killSessionCommand('x', 'none'), null);
});

// Regression guard. herdr v0.7.5 has no HERDR_SESSION env var, so the env-var
// form resolves to the *default* socket: it would stop the user's own herdr
// session and leave the expired one running. Only `session stop <name>` targets
// by name. Verified against the real binary.
test('killSessionCommand: herdr teardown addresses the session by name, never via env', () => {
  const cmd = killSessionCommand('tch_p', 'herdr')!;
  assert.doesNotMatch(cmd, /HERDR_SESSION/);
  assert.match(cmd, /herdr session stop 'tch_p'/);
  assert.match(cmd, /herdr session delete 'tch_p'/);
});

test('killSessionCommand: strips quotes so a crafted phone id cannot break out', () => {
  assert.equal(killSessionCommand("a'; rm -rf ~; '", 'tmux'), "tmux kill-session -t 'a; rm -rf ~; ' 2>/dev/null");
  assert.doesNotMatch(killSessionCommand("a'; rm -rf ~; '", 'herdr')!, /rm -rf ~;'/);
});

test('multiplexerFromConfig: a legacy config with no field means tmux', () => {
  assert.equal(multiplexerFromConfig({}), 'tmux');
  assert.equal(multiplexerFromConfig({ multiplexer: 'herdr' }), 'herdr');
});

test('multiplexerFromConfig: --no-tmux maps to none', () => {
  assert.equal(multiplexerFromConfig({}, { tmux: false }), 'none');
});

test('multiplexerFromConfig: an explicit flag beats the stored config', () => {
  assert.equal(multiplexerFromConfig({ multiplexer: 'tmux' }, { multiplexer: 'herdr' }), 'herdr');
});

test('multiplexerFromConfig: --multiplexer wins over --no-tmux when both are given', () => {
  assert.equal(multiplexerFromConfig({}, { multiplexer: 'herdr', tmux: false }), 'herdr');
});

test('describeMultiplexerStatus: marks the active one and flags what is missing', () => {
  const out = describeMultiplexerStatus('herdr', { tmux: true, herdr: false });
  assert.match(out, /herdr.*active/);
  assert.match(out, /not installed/);
});

test('describeMultiplexerStatus: none needs no binary, so it is never "not installed"', () => {
  const lines = describeMultiplexerStatus('none', { tmux: false, herdr: false }).split('\n');
  const noneLine = lines.find(l => l.includes('none'))!;
  assert.doesNotMatch(noneLine, /installed/);
  assert.match(noneLine, /active/);
});

test('sendKeysCommand: tmux sends the literal text then Enter', () => {
  const command = sendKeysCommand('tc_p1', 'hello world', 'tmux');

  assert.equal(command, "tmux send-keys -t 'tc_p1' -l 'hello world' && tmux send-keys -t 'tc_p1' Enter");
});

test('sendKeysCommand: single quotes in the text cannot break out of the shell quoting', () => {
  // A message containing a quote must never become shell syntax.
  const command = sendKeysCommand('tc_p1', "it's fine", 'tmux');

  assert.ok(command !== null);
  assert.ok(!command.includes("'it's fine'"));
  assert.ok(command.includes(`'it'\\''s fine'`));
});

test('sendKeysCommand: herdr addresses the session by name', () => {
  const command = sendKeysCommand('tch_p1', 'hello', 'herdr');

  assert.ok(command?.includes('tch_p1'));
  assert.ok(command?.includes('hello'));
});

test('sendKeysCommand: none has no injection mechanism', () => {
  assert.equal(sendKeysCommand('tc_p1', 'hello', 'none'), null);
});

test('sendKeysCommand: an empty message produces no command', () => {
  assert.equal(sendKeysCommand('tc_p1', '   ', 'tmux'), null);
});

test('activeMultiplexer: parses the sidecar values it will encounter', () => {
  // The sidecar is absent until `start` writes it; tmux is the documented
  // default and must not become 'none' (which disables desk injection).
  assert.equal(parseMultiplexer(''), 'tmux');
  assert.equal(parseMultiplexer('herdr'), 'herdr');
  assert.equal(parseMultiplexer('nonsense'), 'tmux');
});

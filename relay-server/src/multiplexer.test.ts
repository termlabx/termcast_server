import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMultiplexer, sessionNameFor, killSessionCommand, multiplexerFromConfig,
} from './multiplexer.js';

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
  assert.equal(killSessionCommand('tch_p', 'herdr'), "HERDR_SESSION='tch_p' herdr server stop 2>/dev/null");
  assert.equal(killSessionCommand('x', 'none'), null);
});

test('killSessionCommand: strips quotes so a crafted phone id cannot break out', () => {
  assert.equal(killSessionCommand("a'; rm -rf ~; '", 'tmux'), "tmux kill-session -t 'a; rm -rf ~; ' 2>/dev/null");
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

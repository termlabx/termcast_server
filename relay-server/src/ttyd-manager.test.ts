import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMultiplexerShellArgs } from './ttyd-manager.js';

const base = {
  shell: '/bin/zsh',
  tmuxPath: '/usr/bin/tmux',
  herdrPath: '/home/u/.termcast/bin/herdr',
  sidecarPath: '/home/u/.ttyd-server/multiplexer',
  fallback: 'tmux' as const,
};

test('buildMultiplexerShellArgs: $1 is the phone id, $2 the multiplexer', () => {
  const args = buildMultiplexerShellArgs(base);
  assert.equal(args[0], '/bin/zsh');
  assert.equal(args[1], '-c');
  assert.equal(args[3], 'termcast'); // $0 placeholder so url-args land in $1/$2
  const script = args[2];
  assert.match(script, /\$\{1:-shared\}/);
  assert.match(script, /\$\{2:-/);
});

test('buildMultiplexerShellArgs: $2 falls back to the sidecar file, then the default', () => {
  const script = buildMultiplexerShellArgs(base)[2];
  assert.match(script, /cat '\/home\/u\/\.ttyd-server\/multiplexer' 2>\/dev\/null \|\| echo tmux/);
});

test('buildMultiplexerShellArgs: stays POSIX — tr, not bash pattern substitution', () => {
  const script = buildMultiplexerShellArgs(base)[2];
  assert.match(script, /tr -c 'A-Za-z0-9_' '_'/);
  assert.doesNotMatch(script, /\$\{s\/\//);
});

test('buildMultiplexerShellArgs: tmux keeps the exact legacy session name', () => {
  const script = buildMultiplexerShellArgs(base)[2];
  assert.match(script, /exec '\/usr\/bin\/tmux' new-session -A -s "tc_\$s"/);
});

test('buildMultiplexerShellArgs: herdr attaches-or-creates its own namespace', () => {
  const script = buildMultiplexerShellArgs(base)[2];
  assert.match(script, /herdr\) exec '\/home\/u\/\.termcast\/bin\/herdr' --session "tch_\$s"/);
});

test('buildMultiplexerShellArgs: none execs the bare shell', () => {
  const script = buildMultiplexerShellArgs(base)[2];
  assert.match(script, /none\) exec '\/bin\/zsh'/);
});

test('buildMultiplexerShellArgs: an unresolved binary gets no branch at all', () => {
  const script = buildMultiplexerShellArgs({ ...base, herdrPath: null })[2];
  assert.doesNotMatch(script, /herdr\)/);
  assert.match(script, /new-session -A -s/);
});

test('buildMultiplexerShellArgs: no tmux and no herdr degrades to a bare shell', () => {
  const script = buildMultiplexerShellArgs({ ...base, tmuxPath: null, herdrPath: null })[2];
  assert.doesNotMatch(script, /new-session/);
  assert.match(script, /exec '\/bin\/zsh'/);
});

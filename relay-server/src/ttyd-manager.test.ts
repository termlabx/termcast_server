import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTmuxShellArgs } from './ttyd-manager.js';

test('buildTmuxShellArgs: passes $1 through tmux new-session -A with tc_ prefix', () => {
  const args = buildTmuxShellArgs('/bin/zsh', '/usr/bin/tmux');
  assert.equal(args[0], '/bin/zsh');
  assert.equal(args[1], '-c');
  const script = args[2];
  // Default when no url-arg is provided (browser/local view).
  assert.match(script, /\$\{1:-shared\}/);
  // Sanitizes and prefixes to match sessionNameFor(), using POSIX-portable
  // `tr` rather than the bash-only `${s//pat/rep}` expansion, so the wrapper
  // works when the shell is dash (/bin/sh on Debian/Ubuntu), busybox ash, etc.
  assert.match(script, /tc_\$\(printf %s "\$s" \| tr -c 'A-Za-z0-9_' '_'\)/);
  // MUST NOT use the bash-only pattern-substitution expansion.
  assert.doesNotMatch(script, /\$\{s\/\//);
  assert.match(script, /new-session -A -s/);
  assert.match(script, /\/usr\/bin\/tmux/);
  // $0 placeholder so the first url-arg lands in $1.
  assert.equal(args[3], 'termcast');
});

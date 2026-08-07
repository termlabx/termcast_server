import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMultiplexerShellArgs, resolveWrapperMultiplexers, stripNestingEnv, wrapperSignature } from './ttyd-manager.js';

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
  assert.match(script, /exec '\/usr\/bin\/tmux' new-session -A -s "tc_\$sname"/);
});

test('buildMultiplexerShellArgs: herdr attaches-or-creates its own namespace', () => {
  const script = buildMultiplexerShellArgs(base)[2];
  assert.match(script, /herdr:\*\) exec '\/home\/u\/\.termcast\/bin\/herdr' --session "tch_\$sname"/);
});

test('buildMultiplexerShellArgs: none execs the bare shell', () => {
  const script = buildMultiplexerShellArgs(base)[2];
  assert.match(script, /none:\*\) exec '\/bin\/zsh'/);
});

test('buildMultiplexerShellArgs: attach mode uses the session name verbatim, unprefixed and unsanitised', () => {
  const script = buildMultiplexerShellArgs(base)[2];
  // Attach mode ($3 = 1) skips the sanitisation prefix path entirely.
  assert.match(script, /\$\{3:-\}/);
  assert.match(script, /if \[ "\$a" = "1" \]; then sname="\$s"/);
  // tmux and herdr attach branches take the raw name (no tc_/tch_ prefix).
  assert.match(script, /\*:1\) exec '\/usr\/bin\/tmux' new-session -A -s "\$sname"/);
  assert.match(script, /herdr:1\) exec '\/home\/u\/\.termcast\/bin\/herdr' --session "\$sname"/);
});

test('buildMultiplexerShellArgs: an unresolved binary gets no branch at all', () => {
  const script = buildMultiplexerShellArgs({ ...base, herdrPath: null })[2];
  assert.doesNotMatch(script, /herdr:1\)/);
  assert.doesNotMatch(script, /herdr:\*\)/);
  assert.match(script, /new-session -A -s/);
});

test('buildMultiplexerShellArgs: no tmux and no herdr degrades to a bare shell', () => {
  const script = buildMultiplexerShellArgs({ ...base, tmuxPath: null, herdrPath: null })[2];
  assert.doesNotMatch(script, /new-session/);
  assert.match(script, /exec '\/bin\/zsh'/);
});

// Starting the server from inside a multiplexer is normal. If its nesting
// markers reach ttyd, every connection dies on spawn: herdr exits 1 with
// "nested herdr is disabled by default" (verified against v0.7.5) and tmux
// refuses to nest a new session.
test('stripNestingEnv: drops every herdr and tmux nesting marker', () => {
  const cleaned = stripNestingEnv({
    HERDR_ENV: '1',
    HERDR_PANE_ID: 'w6:p1',
    HERDR_SOCKET_PATH: '/Users/u/.config/herdr/herdr.sock',
    HERDR_TAB_ID: 'w6:t1',
    HERDR_WORKSPACE_ID: 'w6',
    HERDR_STARTUP_CWD: '/Users/u',
    TMUX: '/tmp/tmux-501/default,123,0',
    TMUX_PANE: '%3',
  });
  assert.deepEqual(cleaned, {});
});

test('stripNestingEnv: leaves unrelated variables untouched and does not mutate its input', () => {
  const env = { PATH: '/usr/bin', HOME: '/Users/u', TERM: 'xterm-256color', HERDR_ENV: '1' };
  const cleaned = stripNestingEnv(env);
  assert.deepEqual(cleaned, { PATH: '/usr/bin', HOME: '/Users/u', TERM: 'xterm-256color' });
  assert.equal(env.HERDR_ENV, '1', 'process.env must not be mutated');
});

test('wrapperSignature: identical argv yields an identical fingerprint', () => {
  const a = buildMultiplexerShellArgs(base);
  const b = buildMultiplexerShellArgs(base);
  assert.equal(wrapperSignature(a), wrapperSignature(b));
  assert.match(wrapperSignature(a), /^[0-9a-f]{8}$/);
});

test('resolveWrapperMultiplexers: a none default still resolves installed binaries so an explicit attach is honoured', async () => {
  // The phone picker lists tmux/herdr sessions by what is INSTALLED, not by the
  // machine's default multiplexer. A `none` default must therefore still hand
  // those binaries to the wrapper — otherwise TERMINAL_ATTACH for a listed
  // session falls through to `/bin/zsh` and the terminal opens the wrong thing.
  const result = await resolveWrapperMultiplexers('none', {
    findOrInstallTmux: async () => { throw new Error('none must never download tmux'); },
    findOrInstallHerdr: async () => { throw new Error('none must never download herdr'); },
    resolveInstalled: (mux) => mux === 'tmux' ? '/usr/bin/tmux' : '/home/u/.local/bin/herdr',
  });

  assert.deepEqual(result, { tmux: '/usr/bin/tmux', herdr: '/home/u/.local/bin/herdr' });
});

test('resolveWrapperMultiplexers: a none default with nothing installed yields no branches', async () => {
  const result = await resolveWrapperMultiplexers('none', {
    findOrInstallTmux: async () => { throw new Error('must not download under none'); },
    findOrInstallHerdr: async () => { throw new Error('must not download under none'); },
    resolveInstalled: () => null,
  });

  assert.deepEqual(result, { tmux: null, herdr: null });
  // Nothing installed means the wrapper must degrade to a bare shell, exactly
  // as it does today for a machine that never had a multiplexer.
  const args = buildMultiplexerShellArgs({
    shell: '/bin/zsh',
    tmuxPath: result.tmux,
    herdrPath: result.herdr,
    sidecarPath: '/home/u/.ttyd-server/multiplexer',
    fallback: 'none',
  });
  assert.doesNotMatch(args[2], /herdr:1\)/);
  assert.doesNotMatch(args[2], /new-session -A -s/);
});

test('resolveWrapperMultiplexers: an explicit multiplexer goes through find-or-install', async () => {
  const result = await resolveWrapperMultiplexers('tmux', {
    findOrInstallTmux: async () => '/usr/bin/tmux',
    findOrInstallHerdr: async () => '/home/u/.termcast/bin/herdr',
    resolveInstalled: () => { throw new Error('not used outside none'); },
  });

  assert.deepEqual(result, { tmux: '/usr/bin/tmux', herdr: '/home/u/.termcast/bin/herdr' });
});

test('wrapperSignature: any binary change flips the fingerprint (stale-orphan guard)', () => {
  const withTmux = wrapperSignature(buildMultiplexerShellArgs(base));
  const tmuxGone = wrapperSignature(buildMultiplexerShellArgs({ ...base, tmuxPath: null, herdrPath: null }));
  const herdrAdded = wrapperSignature(buildMultiplexerShellArgs({ ...base, herdrPath: '/home/u/.local/bin/herdr' }));
  const shellChanged = wrapperSignature(buildMultiplexerShellArgs({ ...base, shell: '/bin/bash' }));
  assert.notEqual(withTmux, tmuxGone);
  assert.notEqual(withTmux, herdrAdded);
  assert.notEqual(withTmux, shellChanged);
  // The same args never collide regardless of how they were produced.
  assert.equal(wrapperSignature(buildMultiplexerShellArgs({ ...base, herdrPath: '/home/u/.local/bin/herdr' })),
    herdrAdded);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listTerminalTargets,
  parseTmuxSessions,
  parseHerdrSessions,
} from './terminal-targets.js';

const noopRunner = async () => ({ stdout: '', code: 1 });

test('terminal-targets: tmux and herdr sessions are listed ahead of a plain shell', async () => {
  const runner: Runner = async (command: string) => {
    if (command.includes("list-sessions")) return { stdout: 'work\nweb.app-server\n', code: 0 };
    if (command.includes("session list")) return { stdout: 'tch_mine\ntch_other\n', code: 0 };
    return { stdout: '', code: 0 };
  };
  const bins = { tmux: '/usr/bin/tmux', herdr: '/home/u/.termcast/bin/herdr' };

  const targets = await listTerminalTargets(runner, bins);

  assert.deepEqual(targets, [
    { kind: 'tmux', id: 'tmux:work', name: 'work' },
    { kind: 'tmux', id: 'tmux:web.app-server', name: 'web.app-server' },
    { kind: 'herdr', id: 'herdr:tch_mine', name: 'tch_mine' },
    { kind: 'herdr', id: 'herdr:tch_other', name: 'tch_other' },
    { kind: 'bash', id: 'bash', name: 'Plain shell' },
  ]);
});

test('tmux-targets: a missing tmux contributes nothing', async () => {
  const targets = await listTerminalTargets(noopRunner, { tmux: null, herdr: null });
  assert.deepEqual(targets, [{ kind: 'bash', id: 'bash', name: 'Plain shell' }]);
});

test('tmux-targets: a multiplexer that errors still yields a plain shell', async () => {
  const runner: Runner = async () => ({ stdout: '', code: 1 });
  const targets = await listTerminalTargets(runner, { tmux: '/usr/bin/tmux', herdr: '/opt/u/herdr' });
  assert.deepEqual(targets, [{ kind: 'bash', id: 'bash', name: 'Plain shell' }]);
});

test('parseTmuxSessions: one name per line, blank lines dropped', () => {
  assert.deepEqual(parseTmuxSessions('\nwork\nweb.app-server\n\n'), ['work', 'web.app-server']);
});

test('parseHerdrSessions: takes the first token and skips header rows', () => {
  const out = 'SESSION  STATUS   PATH\nwork     running  /repo\nserver-1 stopped\n';
  assert.deepEqual(parseHerdrSessions(out), ['work', 'server-1']);
});

// LocalRunner alias so the test doesn't need the private type name.
type Runner = (command: string) => Promise<{ stdout: string; code?: number }>;
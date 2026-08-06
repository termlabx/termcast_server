import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureHooks, writeOptOut, clearOptOut } from './hook-autosetup.js';
import { HOOK_MARKER } from './hook-install.js';

/** A machine with Claude Code installed but no termcast hooks yet. */
function machine(opts: { claude?: boolean; settings?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'autosetup-'));
  const claudeDir = join(root, '.claude');
  if (opts.claude !== false) {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.json'), opts.settings ?? '{}');
  }
  return {
    root,
    deps: {
      claudeDir,
      settingsPath: join(claudeDir, 'settings.json'),
      hookDir: join(root, '.ttyd-server', 'hooks'),
      optOutPath: join(root, '.ttyd-server', 'agent-hooks-optout'),
    },
  };
}

const readSettings = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as {
  hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
};

test('a fresh machine with Claude Code installed gets the hooks', () => {
  const { deps } = machine();

  assert.equal(ensureHooks(deps), 'installed');

  const settings = readSettings(deps.settingsPath);
  const commands = JSON.stringify(settings.hooks);
  assert.match(commands, new RegExp(HOOK_MARKER));
  assert.ok(settings.hooks?.SessionStart, 'SessionStart is what records the pane');
});

test('running twice is a no-op the second time', () => {
  const { deps } = machine();
  ensureHooks(deps);
  const afterFirst = readFileSync(deps.settingsPath, 'utf8');

  assert.equal(ensureHooks(deps), 'already');
  assert.equal(readFileSync(deps.settingsPath, 'utf8'), afterFirst);
});

test("the user's own hooks survive installation", () => {
  // Their config is not ours to rewrite: we add entries, we never replace.
  const existing = JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'python3 /me/guard.py' }] }] },
  });
  const { deps } = machine({ settings: existing });

  ensureHooks(deps);

  const settings = readSettings(deps.settingsPath);
  assert.match(JSON.stringify(settings.hooks?.PreToolUse), /guard\.py/);
});

test('an explicit opt-out is honoured and leaves the settings untouched', () => {
  const { deps } = machine();
  writeOptOut(deps.optOutPath);
  const before = readFileSync(deps.settingsPath, 'utf8');

  assert.equal(ensureHooks(deps), 'opted-out');
  assert.equal(readFileSync(deps.settingsPath, 'utf8'), before);
});

test('a manual re-install beats a stale opt-out marker', () => {
  // hooksInstalled is checked before the marker, so someone who ran `agent
  // setup` by hand is never reported as opted out.
  const { deps } = machine();
  ensureHooks(deps);
  writeOptOut(deps.optOutPath);

  assert.equal(ensureHooks(deps), 'already');
});

test('a machine without Claude Code is left entirely alone', () => {
  const { deps } = machine({ claude: false });

  assert.equal(ensureHooks(deps), 'no-claude');
  assert.equal(existsSync(deps.claudeDir), false, 'must not create config for an absent app');
});

test('a malformed settings file fails without destroying it', () => {
  const { deps } = machine({ settings: '{ this is not json' });

  assert.equal(ensureHooks(deps), 'failed');
  assert.equal(readFileSync(deps.settingsPath, 'utf8'), '{ this is not json');
});

test('the opt-out marker round-trips, and clearing a missing one is not an error', () => {
  const { deps } = machine();

  writeOptOut(deps.optOutPath);
  assert.equal(existsSync(deps.optOutPath), true);
  clearOptOut(deps.optOutPath);
  assert.equal(existsSync(deps.optOutPath), false);
  clearOptOut(deps.optOutPath);
});

test('a Claude install that has never written settings.json still gets the hooks', () => {
  // The onboarding case this whole feature exists for: ~/.claude is created on
  // first run, but settings.json only appears once something writes it.
  const root = mkdtempSync(join(tmpdir(), 'autosetup-'));
  const claudeDir = join(root, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const deps = {
    claudeDir,
    settingsPath: join(claudeDir, 'settings.json'),
    hookDir: join(root, '.ttyd-server', 'hooks'),
    optOutPath: join(root, '.ttyd-server', 'agent-hooks-optout'),
  };

  assert.equal(ensureHooks(deps), 'installed');
  assert.match(readFileSync(deps.settingsPath, 'utf8'), new RegExp(HOOK_MARKER));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHooks, removeHooks, hooksInstalled, HOOK_MARKER } from './hook-install.js';

function settingsFile(contents: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'hooks-')), 'settings.json');
  writeFileSync(path, JSON.stringify(contents, null, 2));
  return path;
}

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

test('installHooks: adds PermissionRequest, SessionStart and SessionEnd entries', () => {
  const path = settingsFile({});

  installHooks(path, { hookDir: '/opt/termcast/hooks' });

  const settings = read(path);
  assert.ok(settings.hooks.PermissionRequest);
  assert.ok(settings.hooks.SessionStart);
  assert.ok(settings.hooks.SessionEnd);
});

test('installHooks: preserves unrelated settings and existing hooks', () => {
  // Clobbering a user's own hooks would be an unacceptable side effect of setup.
  const path = settingsFile({
    model: 'opus',
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'their-script.sh' }] }] },
  });

  installHooks(path, { hookDir: '/opt/termcast/hooks' });

  const settings = read(path);
  assert.equal(settings.model, 'opus');
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'their-script.sh');
});

test('installHooks: is idempotent', () => {
  const path = settingsFile({});

  installHooks(path, { hookDir: '/opt/termcast/hooks' });
  installHooks(path, { hookDir: '/opt/termcast/hooks' });

  assert.equal(read(path).hooks.PermissionRequest.length, 1);
});

test('installHooks: tags entries with a marker so removal is exact', () => {
  const path = settingsFile({});

  installHooks(path, { hookDir: '/opt/termcast/hooks' });

  assert.ok(JSON.stringify(read(path).hooks.PermissionRequest).includes(HOOK_MARKER));
});

test('removeHooks: removes only what we added', () => {
  const path = settingsFile({
    hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'their-own.sh' }] }] },
  });
  installHooks(path, { hookDir: '/opt/termcast/hooks' });

  removeHooks(path);

  const settings = read(path);
  assert.equal(settings.hooks.PermissionRequest.length, 1);
  assert.equal(settings.hooks.PermissionRequest[0].hooks[0].command, 'their-own.sh');
});

test('removeHooks: leaves a file with no termcast hooks untouched', () => {
  const path = settingsFile({ model: 'opus' });

  removeHooks(path);

  assert.deepEqual(read(path), { model: 'opus' });
});

test('hooksInstalled: reports install state', () => {
  const path = settingsFile({});
  assert.equal(hooksInstalled(read(path)), false);

  installHooks(path, { hookDir: '/opt/termcast/hooks' });

  assert.equal(hooksInstalled(read(path)), true);
});

test('installHooks: a corrupt settings file is not destroyed', () => {
  // Overwriting a malformed settings.json would lose the user's configuration.
  const path = join(mkdtempSync(join(tmpdir(), 'hooks-')), 'settings.json');
  writeFileSync(path, '{ this is not json');

  assert.throws(() => installHooks(path, { hookDir: '/opt/termcast/hooks' }));
  assert.equal(readFileSync(path, 'utf8'), '{ this is not json');
});

test('the hook scripts are present where stageHookScripts looks for them', () => {
  // Deliberately resolved with the same expression as stageHookScripts, so the
  // two cannot drift: under `tsx` this is src/assets, in a build it is
  // dist/assets. A build that copies only *.js passes every other test in this
  // file and still ships a daemon whose ensureHooks() throws ENOENT on every
  // start — which is exactly how it reached 0.171.0.
  const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

  for (const asset of ['agent-permission-hook.sh', 'agent-session-hook.sh']) {
    assert.ok(existsSync(join(assets, asset)), `${asset} missing from ${assets}`);
  }
});

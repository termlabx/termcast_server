import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectInstall, decideRestart, binaryKeys, resolveBaseUrl, releaseUrl } from './upgrade.js';

test('binaryKeys: supported platform/arch yields the release keys', () => {
  const k = binaryKeys('linux', 'arm64');
  assert.equal(k.supported, true);
  assert.equal(k.termcastd, 'termcastd-linux-arm64');
  assert.equal(k.tmux, 'tmux-linux-arm64');
});

test('binaryKeys: unsupported platform is flagged', () => {
  assert.equal(binaryKeys('win32', 'x64').supported, false);
  assert.equal(binaryKeys('linux', 'mips').supported, false);
});

test('resolveBaseUrl: honors the env override, else the default', () => {
  assert.equal(resolveBaseUrl({ TERMCAST_RELEASES_URL: 'https://example.test' }), 'https://example.test');
  assert.ok(resolveBaseUrl({}).startsWith('https://'));
});

test('releaseUrl: builds the path and adds the via marker', () => {
  assert.equal(releaseUrl('https://x.test/', 'termcastd-linux-arm64'), 'https://x.test/releases/termcastd-linux-arm64');
  assert.equal(releaseUrl('https://x.test', 'k', { via: 'upgrade' }), 'https://x.test/releases/k?via=upgrade');
});

test('detectInstall: script under ~/.termcast is a shell install', () => {
  assert.equal(detectInstall('/home/me/.termcast/dist/index.js', '/home/me'), 'shell');
});

test('detectInstall: global npm prefix is an npm install', () => {
  assert.equal(detectInstall('/usr/local/lib/node_modules/@termcast/cli/dist/index.js', '/home/me'), 'npm');
});

test('detectInstall: a path that merely contains the string but not under home is npm', () => {
  // Another user's .termcast must not count as our shell install.
  assert.equal(detectInstall('/home/other/.termcast/dist/index.js', '/home/me'), 'npm');
});

test('decideRestart: supervised wrapper present → auto', () => {
  assert.equal(
    decideRestart({ supervisorAlive: true, wrapperExists: true, foregroundAlive: false }),
    'auto',
  );
});

test('decideRestart: supervisor pid alive but no wrapper → not auto (fall through)', () => {
  // Without the wrapper we cannot drive a restart, so treat foreground liveness.
  assert.equal(
    decideRestart({ supervisorAlive: true, wrapperExists: false, foregroundAlive: true }),
    'manual-foreground',
  );
});

test('decideRestart: foreground server alive, unsupervised → manual-foreground', () => {
  assert.equal(
    decideRestart({ supervisorAlive: false, wrapperExists: false, foregroundAlive: true }),
    'manual-foreground',
  );
});

test('decideRestart: nothing running → none', () => {
  assert.equal(
    decideRestart({ supervisorAlive: false, wrapperExists: false, foregroundAlive: false }),
    'none',
  );
});

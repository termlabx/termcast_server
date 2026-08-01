// Tests for the shared npm-postinstall download helper.
// Run: node --test scripts/download.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { binaryKeys, releaseUrl, resolveBaseUrl, downloadToFile, DEFAULT_BASE_URL } from './download.mjs';

test('binaryKeys builds termcastd/tmux keys for a supported platform', () => {
  const k = binaryKeys('darwin', 'arm64');
  assert.equal(k.supported, true);
  assert.equal(k.termcastd, 'termcastd-darwin-arm64');
  assert.equal(k.tmux, 'tmux-darwin-arm64');
});

test('binaryKeys marks Windows and 32-bit as unsupported', () => {
  assert.equal(binaryKeys('win32', 'x64').supported, false);
  assert.equal(binaryKeys('linux', 'ia32').supported, false);
});

test('releaseUrl joins base + key, and adds ?via=npm when asked', () => {
  assert.equal(
    releaseUrl('https://example.com', 'termcastd-linux-x64'),
    'https://example.com/releases/termcastd-linux-x64',
  );
  assert.equal(
    releaseUrl('https://example.com/', 'tmux-linux-x64', { via: 'npm' }),
    'https://example.com/releases/tmux-linux-x64?via=npm',
  );
});

test('resolveBaseUrl prefers TERMCAST_RELEASES_URL over the default', () => {
  assert.equal(resolveBaseUrl({}), DEFAULT_BASE_URL);
  assert.equal(resolveBaseUrl({ TERMCAST_RELEASES_URL: 'http://local' }), 'http://local');
});

test('downloadToFile writes the body atomically, chmods, and leaves no temp file', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(Buffer.from('BINARY-BYTES'));
  });
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const dir = mkdtempSync(join(tmpdir(), 'dl-'));
  const dest = join(dir, 'termcastd-linux-x64');
  try {
    await downloadToFile(`http://127.0.0.1:${port}/bin`, dest, { mode: 0o755 });
    assert.equal(readFileSync(dest, 'utf-8'), 'BINARY-BYTES');
    assert.equal(statSync(dest).mode & 0o777, 0o755);
    // No leftover *.tmp / *.download files in the directory.
    assert.deepEqual(readdirSync(dir), ['termcastd-linux-x64']);
  } finally {
    server.close();
  }
});

test('downloadToFile throws on a non-2xx response and writes nothing', async () => {
  const server = createServer((req, res) => { res.writeHead(404); res.end('nope'); });
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const dir = mkdtempSync(join(tmpdir(), 'dl-'));
  const dest = join(dir, 'termcastd-linux-x64');
  try {
    await assert.rejects(() => downloadToFile(`http://127.0.0.1:${port}/x`, dest), /404/);
    assert.equal(existsSync(dest), false);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    server.close();
  }
});

test('downloadToFile throws on an empty body and writes nothing', async () => {
  const server = createServer((req, res) => { res.writeHead(200); res.end(); });
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const dir = mkdtempSync(join(tmpdir(), 'dl-'));
  const dest = join(dir, 'termcastd-linux-x64');
  try {
    await assert.rejects(() => downloadToFile(`http://127.0.0.1:${port}/x`, dest), /empty/i);
    assert.equal(existsSync(dest), false);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    server.close();
  }
});

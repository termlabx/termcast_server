import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { herdrAssetName, herdrVersion, assetDownloadUrl, pickAsset, verifySha256 } from './herdr-install.js';

test('herdrAssetName: translates Node platform/arch to herdr release naming', () => {
  assert.equal(herdrAssetName('darwin', 'arm64'), 'herdr-macos-aarch64');
  assert.equal(herdrAssetName('darwin', 'x64'), 'herdr-macos-x86_64');
  assert.equal(herdrAssetName('linux', 'arm64'), 'herdr-linux-aarch64');
  assert.equal(herdrAssetName('linux', 'x64'), 'herdr-linux-x86_64');
});

test('herdrAssetName: unsupported platform/arch yields null rather than a bad URL', () => {
  assert.equal(herdrAssetName('win32', 'x64'), null);
  assert.equal(herdrAssetName('linux', 'ia32'), null);
});

test('herdrVersion: pinned by default, overridable by env', () => {
  assert.equal(herdrVersion({}), 'v0.7.5');
  assert.equal(herdrVersion({ TERMCAST_HERDR_VERSION: 'v0.8.0' }), 'v0.8.0');
});

test('assetDownloadUrl: points at the pinned GitHub release asset', () => {
  assert.equal(
    assetDownloadUrl('v0.7.5', 'herdr-macos-aarch64'),
    'https://github.com/herdrdev/herdr/releases/download/v0.7.5/herdr-macos-aarch64',
  );
});

test('pickAsset: finds the asset by exact name and extracts its sha256 digest', () => {
  const release = {
    assets: [
      { name: 'herdr-linux-x86_64', browser_download_url: 'https://x/linux', digest: 'sha256:aaa' },
      { name: 'herdr-macos-aarch64', browser_download_url: 'https://x/mac', digest: 'sha256:bbb' },
    ],
  };
  assert.deepEqual(pickAsset(release, 'herdr-macos-aarch64'), { url: 'https://x/mac', sha256: 'bbb' });
});

test('pickAsset: a missing asset throws rather than silently installing the wrong binary', () => {
  assert.throws(() => pickAsset({ assets: [] }, 'herdr-macos-aarch64'), /herdr-macos-aarch64/);
});

test('pickAsset: an asset with no digest yields null, not a bogus hash', () => {
  const release = { assets: [{ name: 'a', browser_download_url: 'https://x/a' }] };
  assert.deepEqual(pickAsset(release, 'a'), { url: 'https://x/a', sha256: null });
});

test('verifySha256: accepts matching bytes and rejects tampered ones', () => {
  const bytes = Buffer.from('herdr binary');
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(verifySha256(bytes, digest), true);
  assert.equal(verifySha256(Buffer.from('tampered'), digest), false);
});

test('verifySha256: no published digest means we cannot verify, so refuse', () => {
  assert.equal(verifySha256(Buffer.from('x'), null), false);
});

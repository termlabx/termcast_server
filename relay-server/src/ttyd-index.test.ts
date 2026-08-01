import { test } from 'node:test';
import assert from 'node:assert/strict';
import { injectClipboardScript, augmentedIndexPath } from './ttyd-index.js';

test('injects the script immediately after the opening <head> tag', () => {
  const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><script>bundle()</script></body></html>';
  const out = injectClipboardScript(html, 'CLIP();');

  // Our script must appear before the body bundle so it can wrap WebSocket.
  const injectedAt = out.indexOf('CLIP();');
  const bundleAt = out.indexOf('bundle()');
  assert.ok(injectedAt > -1, 'injected script present');
  assert.ok(injectedAt < bundleAt, 'injected script runs before the body bundle');
  // It should sit inside <head>, right after the opening tag.
  assert.match(out, /<head[^>]*>\s*<script>CLIP\(\);<\/script>/);
});

test('handles a <head> tag with attributes', () => {
  const html = '<html><head lang="en"><title>x</title></head><body></body></html>';
  const out = injectClipboardScript(html, 'CLIP();');
  assert.match(out, /<head lang="en"><script>CLIP\(\);<\/script>/);
});

test('throws when there is no <head> to inject into', () => {
  assert.throws(() => injectClipboardScript('<html><body></body></html>', 'CLIP();'),
    /no <head>/i);
});

test('cache path is deterministic and lives under the cache dir', () => {
  const a = augmentedIndexPath('/cache', '1.7.7', 'SCRIPT_A');
  const b = augmentedIndexPath('/cache', '1.7.7', 'SCRIPT_A');
  assert.equal(a, b);
  assert.ok(a.startsWith('/cache/'));
  assert.match(a, /ttyd-index-.*\.html$/);
  assert.ok(a.includes('1.7.7'));
});

test('cache path changes when the ttyd version changes', () => {
  const a = augmentedIndexPath('/cache', '1.7.7', 'SCRIPT');
  const b = augmentedIndexPath('/cache', '1.7.8', 'SCRIPT');
  assert.notEqual(a, b);
});

test('cache path changes when the injected script changes', () => {
  const a = augmentedIndexPath('/cache', '1.7.7', 'SCRIPT_A');
  const b = augmentedIndexPath('/cache', '1.7.7', 'SCRIPT_B');
  assert.notEqual(a, b);
});

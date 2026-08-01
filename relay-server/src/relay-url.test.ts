import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRelayUrl, relayHttpUrl } from './relay-url.js';

test('resolveRelayUrl: flag wins over env', () => {
  const r = resolveRelayUrl('wss://flag.example.com', { TERMCAST_RELAY_URL: 'wss://env.example.com' });
  assert.deepEqual(r, { ok: true, url: 'wss://flag.example.com' });
});

test('resolveRelayUrl: falls back to TERMCAST_RELAY_URL', () => {
  const r = resolveRelayUrl(undefined, { TERMCAST_RELAY_URL: 'wss://env.example.com' });
  assert.deepEqual(r, { ok: true, url: 'wss://env.example.com' });
});

test('resolveRelayUrl: no relay configured is an error, not a default', () => {
  const r = resolveRelayUrl(undefined, {});
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.error : '', /No relay URL configured/);
});

test('resolveRelayUrl: blank and whitespace-only values count as unset', () => {
  assert.equal(resolveRelayUrl('   ', {}).ok, false);
  assert.equal(resolveRelayUrl(undefined, { TERMCAST_RELAY_URL: '' }).ok, false);
});

test('resolveRelayUrl: normalises http(s) to ws(s)', () => {
  assert.deepEqual(resolveRelayUrl('https://r.example.com', {}), { ok: true, url: 'wss://r.example.com' });
  assert.deepEqual(resolveRelayUrl('http://localhost:8787', {}), { ok: true, url: 'ws://localhost:8787' });
});

test('resolveRelayUrl: strips trailing slashes', () => {
  assert.deepEqual(resolveRelayUrl('wss://r.example.com//', {}), { ok: true, url: 'wss://r.example.com' });
});

test('resolveRelayUrl: rejects a missing or unknown scheme', () => {
  assert.equal(resolveRelayUrl('relay.example.com', {}).ok, false);
  assert.equal(resolveRelayUrl('ftp://relay.example.com', {}).ok, false);
});

test('resolveRelayUrl: rejects a scheme with no host', () => {
  assert.equal(resolveRelayUrl('wss://', {}).ok, false);
  assert.equal(resolveRelayUrl('wss:///api', {}).ok, false);
});

test('relayHttpUrl: maps ws schemes onto http', () => {
  assert.equal(relayHttpUrl('wss://r.example.com'), 'https://r.example.com');
  assert.equal(relayHttpUrl('ws://localhost:8787'), 'http://localhost:8787');
});

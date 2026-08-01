import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClientLogEvents } from './server-log-parser.js';

test('parses a "Client connected [id=N]" line', () => {
  assert.deepEqual(parseClientLogEvents('Client connected [id=3]'), [
    { kind: 'connected', id: 3 },
  ]);
});

test('parses a "Client info [id=N]: ..." line and trims it', () => {
  assert.deepEqual(parseClientLogEvents('Client info [id=2]: 1.2.3.4 | Berlin, DE | iPhone  '), [
    { kind: 'info', id: 2, info: '1.2.3.4 | Berlin, DE | iPhone' },
  ]);
});

test('parses a "Client disconnected [id=N]" line', () => {
  assert.deepEqual(parseClientLogEvents('Client disconnected [id=7]'), [
    { kind: 'disconnected', id: 7 },
  ]);
});

test('parses the "[pairing] consumed" line', () => {
  assert.deepEqual(parseClientLogEvents('[pairing] consumed\n'), [
    { kind: 'pairing-consumed' },
  ]);
});

test('extracts events from a multi-line chunk in order', () => {
  const chunk = [
    'Client connected [id=1]',
    'Client info [id=1]: 9.9.9.9 | US | Safari',
    '\x1b[32m✓ Client paired [id=1] — E2E encryption active\x1b[0m',
  ].join('\n');
  assert.deepEqual(parseClientLogEvents(chunk), [
    { kind: 'connected', id: 1 },
    { kind: 'info', id: 1, info: '9.9.9.9 | US | Safari' },
  ]);
});

test('ignores unrelated lines', () => {
  assert.deepEqual(parseClientLogEvents('Web UI: http://127.0.0.1:7682/'), []);
  assert.deepEqual(parseClientLogEvents('✓ Connected to relay'), []);
  assert.deepEqual(parseClientLogEvents('Mesh peer: macbook|8888'), []);
});

test('does not treat "Client paired" as a connect (avoids double-counting)', () => {
  // The server emits both "Client connected [id=N]" and "Client paired [id=N]";
  // only the former should register a client.
  assert.deepEqual(parseClientLogEvents('✓ Client paired [id=4] — E2E encryption active'), []);
});

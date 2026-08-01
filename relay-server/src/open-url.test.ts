import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openCommand } from './open-url.js';

test('macOS uses open', () => {
  assert.deepEqual(openCommand('darwin', 'http://localhost:7682'),
    { cmd: 'open', args: ['http://localhost:7682'] });
});

test('Windows uses cmd start', () => {
  assert.deepEqual(openCommand('win32', 'http://localhost:7682'),
    { cmd: 'cmd', args: ['/c', 'start', '', 'http://localhost:7682'] });
});

test('Linux/other uses xdg-open', () => {
  assert.deepEqual(openCommand('linux', 'http://localhost:7682'),
    { cmd: 'xdg-open', args: ['http://localhost:7682'] });
});

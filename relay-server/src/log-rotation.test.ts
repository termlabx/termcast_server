import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsRotation, backupTail } from './log-rotation.js';

test('needsRotation is false at or under the cap', () => {
  assert.equal(needsRotation(1000, 1000), false);
  assert.equal(needsRotation(999, 1000), false);
});

test('needsRotation is true once the log exceeds the cap', () => {
  assert.equal(needsRotation(1001, 1000), true);
});

test('backupTail returns the content unchanged when it already fits', () => {
  const content = Buffer.from('short');
  assert.equal(backupTail(content, 100), content);
});

test('backupTail keeps only the last maxBytes (copytruncate: mirrors tail -c)', () => {
  const content = Buffer.from('0123456789');
  assert.deepEqual(backupTail(content, 4), Buffer.from('6789'));
});

test('backupTail on an empty buffer returns an empty buffer', () => {
  assert.deepEqual(backupTail(Buffer.alloc(0), 10), Buffer.alloc(0));
});

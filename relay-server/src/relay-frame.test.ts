import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeServerFrame, decodeServerFrame } from './relay-frame.js';

test('round-trips type, connId, and payload', () => {
  const decoded = decodeServerFrame(encodeServerFrame(0x03, 9, Buffer.from([1, 2, 3])));
  assert.equal(decoded.type, 0x03);
  assert.equal(decoded.connId, 9);
  assert.deepEqual([...decoded.payload], [1, 2, 3]);
});

test('handles an empty payload', () => {
  const decoded = decodeServerFrame(encodeServerFrame(0x02, 1, Buffer.alloc(0)));
  assert.equal(decoded.connId, 1);
  assert.equal(decoded.payload.length, 0);
});

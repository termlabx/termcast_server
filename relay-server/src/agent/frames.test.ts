import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_LIST, AGENT_SESSIONS, AGENT_HISTORY,
  isAgentOpcode, encodeAgentFrame, decodeAgentFrame,
} from './frames.js';

test('encodeAgentFrame: opcode byte then JSON payload', () => {
  const frame = encodeAgentFrame(AGENT_LIST, { hello: 'world' });

  assert.equal(frame[0], 0x60);
  assert.deepEqual(JSON.parse(frame.subarray(1).toString('utf8')), { hello: 'world' });
});

test('decodeAgentFrame: round-trips what encodeAgentFrame produced', () => {
  const decoded = decodeAgentFrame(encodeAgentFrame(AGENT_SESSIONS, { sessions: [] }));

  assert.deepEqual(decoded, { opcode: AGENT_SESSIONS, payload: { sessions: [] } });
});

test('decodeAgentFrame: malformed JSON yields null rather than throwing', () => {
  const frame = Buffer.concat([Buffer.from([AGENT_HISTORY]), Buffer.from('{not json')]);

  assert.equal(decodeAgentFrame(frame), null);
});

test('decodeAgentFrame: an empty frame yields null', () => {
  assert.equal(decodeAgentFrame(Buffer.alloc(0)), null);
});

test('decodeAgentFrame: a non-agent opcode yields null so it falls through to ttyd', () => {
  const frame = Buffer.concat([Buffer.from([0x53]), Buffer.from('{}')]);

  assert.equal(decodeAgentFrame(frame), null);
});

test('isAgentOpcode: claims only 0x60-0x68, never the ranges already in use', () => {
  assert.equal(isAgentOpcode(0x60), true);
  assert.equal(isAgentOpcode(0x68), true);
  assert.equal(isAgentOpcode(0x09), false);  // mesh invite
  assert.equal(isAgentOpcode(0x41), false);  // port-forward
  assert.equal(isAgentOpcode(0x53), false);  // set-multiplexer
  assert.equal(isAgentOpcode(0x69), false);
  assert.equal(isAgentOpcode(0x30), false);  // ttyd data
});

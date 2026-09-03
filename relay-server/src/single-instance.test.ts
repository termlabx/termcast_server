import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRunningState, isPidAlive } from './single-instance.js';

// Two termcast daemons (the shell CLI and the Termcast.app tray daemon) can
// end up sharing one ~/.ttyd-server identity. `start` uses these to detect a
// live instance before doing anything else — see single-instance.ts.

test('parseRunningState reads a pid and webPort out of state.json', () => {
  assert.deepEqual(parseRunningState('{"pid":123,"webPort":8080}'), { pid: 123, webPort: 8080 });
});

test('parseRunningState returns null when there is no pid', () => {
  assert.equal(parseRunningState('{}'), null);
  assert.equal(parseRunningState('{"webPort":8080}'), null);
});

test('parseRunningState returns null on malformed JSON', () => {
  assert.equal(parseRunningState('not json'), null);
});

test('isPidAlive is true when the probe succeeds', () => {
  assert.equal(isPidAlive(123, () => {}), true);
});

test('isPidAlive is false when the probe throws ESRCH (process is gone)', () => {
  const err = Object.assign(new Error('no such process'), { code: 'ESRCH' });
  assert.equal(isPidAlive(123, () => { throw err; }), false);
});

test('isPidAlive is true when the probe throws EPERM (alive, owned by another user — still a conflict)', () => {
  const err = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  assert.equal(isPidAlive(123, () => { throw err; }), true);
});

test('isPidAlive is false on any other error (treat as gone rather than block forever)', () => {
  const err = Object.assign(new Error('weird'), { code: 'EINVAL' });
  assert.equal(isPidAlive(123, () => { throw err; }), false);
});

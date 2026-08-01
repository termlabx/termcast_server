import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRecoverFromTtydExit } from './ttyd-restart-policy.js';

// termcastd (ttyd) is the local terminal backend. If it exits for ANY reason
// while we are still serving, the relay can no longer bridge terminal traffic —
// the phone pairs ("connected") but no terminal opens — so we must recover.

test('recovers when termcastd is killed gracefully (SIGTERM → code 0, no signal)', () => {
  // Regression: a graceful SIGTERM makes ttyd exit with code 0 and signal null.
  // The old handler only recovered on `(code !== 0) || signal`, so this exact
  // case silently left the relay running against a dead backend forever.
  assert.equal(shouldRecoverFromTtydExit({ shuttingDown: false, code: 0, signal: null }), true);
});

test('recovers when termcastd dies abnormally (non-zero code)', () => {
  assert.equal(shouldRecoverFromTtydExit({ shuttingDown: false, code: 1, signal: null }), true);
});

test('recovers when termcastd is killed by an unhandled signal', () => {
  assert.equal(shouldRecoverFromTtydExit({ shuttingDown: false, code: null, signal: 'SIGKILL' }), true);
});

test('does NOT recover during our own shutdown (we stopped ttyd intentionally)', () => {
  assert.equal(shouldRecoverFromTtydExit({ shuttingDown: true, code: 0, signal: null }), false);
  assert.equal(shouldRecoverFromTtydExit({ shuttingDown: true, code: null, signal: 'SIGTERM' }), false);
});

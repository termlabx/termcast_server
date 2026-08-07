import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from './adapter.js';

/**
 * Like `types.test.ts`, the union membership here is a compile-time assertion
 * checked by `npm run build`; the runtime half covers what tsc cannot — that
 * the event survives the JSON hop to the phone with its outcome intact.
 */
test('a resolution names the outcome and may carry what was chosen', () => {
  const event: AgentEvent = {
    kind: 'questionResolved',
    sessionId: 's1',
    seq: 42,
    requestId: 'r1',
    outcome: 'answered_elsewhere',
    answers: ['Resume full session as-is'],
    detail: 'Answered at your desk.',
  };
  assert.equal(event.kind, 'questionResolved');

  const decoded = JSON.parse(JSON.stringify(event));
  assert.equal(decoded.outcome, 'answered_elsewhere');
  assert.deepEqual(decoded.answers, ['Resume full session as-is']);
  assert.equal(decoded.requestId, 'r1');
});

test('every outcome the design names is representable', () => {
  const outcomes = [
    'answered', 'rejected', 'answered_elsewhere',
    'superseded', 'expired', 'unavailable',
  ] as const;

  for (const outcome of outcomes) {
    const event: AgentEvent = {
      kind: 'questionResolved', sessionId: 's', seq: 0, requestId: 'r', outcome,
    };
    assert.equal(event.kind === 'questionResolved' && event.outcome, outcome);
  }
});

// A resolution with no answers is the common case — expired, unavailable and
// superseded all have nothing to show. It must not serialise `answers: null`,
// which the phone would read as "answered with nothing".
test('a resolution with nothing chosen omits answers entirely', () => {
  const event: AgentEvent = {
    kind: 'questionResolved', sessionId: 's', seq: 0, requestId: 'r', outcome: 'expired',
  };
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(event)), 'answers'), false);
});

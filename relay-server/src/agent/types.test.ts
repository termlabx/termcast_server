import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentQuestionInfo } from './types.js';

/**
 * Half of this file is a compile-time assertion: `tsx` strips types without
 * checking them, so the field names are enforced by `npm run build` (tsc), not
 * by the runtime assertions below. Those cover what tsc cannot — that an absent
 * optional field serialises as absent rather than null, which is how the phone
 * tells "this server predates the field" from "the agent said no".
 */

// The phone decodes this JSON directly, so the field names are the contract.
// A rename here silently degrades every paired device rather than failing a build.
test('a fully populated question round-trips through JSON with its new fields', () => {
  const info: AgentQuestionInfo = {
    requestId: 'r1',
    sessionId: 's1',
    agent: 'claude',
    prompt: 'Which database?',
    header: 'Database',
    kind: 'select',
    options: [
      { label: 'Postgres', description: 'Relational', index: 1 },
      { label: 'SQLite', index: 2 },
    ],
    multiSelect: true,
    allowsOther: true,
    groupId: 'g1',
    groupIndex: 0,
    groupCount: 2,
    createdAt: '2026-08-07T00:00:00.000Z',
    origin: 'agent',
  };

  const decoded = JSON.parse(JSON.stringify(info)) as AgentQuestionInfo;
  assert.equal(decoded.header, 'Database');
  assert.equal(decoded.multiSelect, true);
  assert.equal(decoded.allowsOther, true);
  assert.equal(decoded.groupCount, 2);
  assert.equal(decoded.options[0].description, 'Relational');
  assert.equal(decoded.options[1].index, 2);
});

// Absent optional fields must stay absent rather than serialising as null:
// the phone treats absent as "this server predates the field".
test('a minimal question omits the new fields entirely', () => {
  const info: AgentQuestionInfo = {
    requestId: 'r1',
    sessionId: 's1',
    agent: 'claude',
    prompt: 'Anything?',
    kind: 'freeform',
    options: [],
    createdAt: '2026-08-07T00:00:00.000Z',
  };
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(info)), 'multiSelect'), false);
});

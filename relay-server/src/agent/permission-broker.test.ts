import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionBroker } from './permission-broker.js';
import type { AgentPermissionRequest } from './adapter.js';

const req = (id: string): AgentPermissionRequest => ({
  requestId: id, sessionId: 's1', agent: 'claude', toolName: 'Bash', toolUseId: 't1',
  summary: 'npm test', input: '{}', truncated: false, createdAt: new Date().toISOString(),
});

test('request: resolves with the answer given to resolve()', async () => {
  const broker = new PermissionBroker();
  const pending = broker.request(req('r1'), 1000);

  broker.resolve('r1', 'allow');

  assert.equal(await pending, 'allow');
});

test('request: notifies listeners so attached phones can render a card', async () => {
  const broker = new PermissionBroker();
  const seen: string[] = [];
  broker.onRequest((r) => seen.push(r.requestId));

  const pending = broker.request(req('r1'), 200);
  broker.resolve('r1', 'deny');
  await pending;

  assert.deepEqual(seen, ['r1']);
});

test('request: an unanswered request resolves to unanswered, never to allow', async () => {
  // Timing out into "allow" would let a dropped phone approve a shell command.
  const broker = new PermissionBroker();

  const result = await broker.request(req('r1'), 30);

  assert.equal(result, 'unanswered');
});

test('resolve: an unknown requestId is ignored', () => {
  const broker = new PermissionBroker();

  assert.doesNotThrow(() => broker.resolve('nope', 'allow'));
});

test('resolve: a second answer for the same request is ignored', async () => {
  const broker = new PermissionBroker();
  const pending = broker.request(req('r1'), 1000);

  broker.resolve('r1', 'deny');
  broker.resolve('r1', 'allow');

  assert.equal(await pending, 'deny');
});

test('releaseAll: unblocks everything as unanswered when the last phone detaches', async () => {
  // Holding the agent for the full 10-minute hook timeout after the phone has
  // gone is worse than falling back to the terminal prompt immediately.
  const broker = new PermissionBroker();
  const pending = broker.request(req('r1'), 60_000);

  broker.releaseAll();

  assert.equal(await pending, 'unanswered');
});

test('pending: lists outstanding requests and empties as they resolve', async () => {
  const broker = new PermissionBroker();
  const one = broker.request(req('r1'), 1000);

  assert.deepEqual(broker.pending().map((r) => r.requestId), ['r1']);

  broker.resolve('r1', 'allow');
  await one;

  assert.deepEqual(broker.pending(), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from './claude-adapter.js';
import { OpencodeAdapter, AgentUnsupportedError } from './opencode-adapter.js';
import { OpencodeClient } from './opencode-client.js';

const line = (text: string) => JSON.stringify({
  type: 'user',
  uuid: `id-${text}`,
  timestamp: '2026-08-02T10:00:00.000Z',
  cwd: '/repo',
  isSidechain: false,
  message: { role: 'user', content: [{ type: 'text', text }] },
});

function claudeRoot(sessionId: string, lines: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'adapter-'));
  mkdirSync(join(root, '-repo'), { recursive: true });
  writeFileSync(join(root, '-repo', `${sessionId}.jsonl`), lines.join('\n') + '\n');
  return root;
}

test('ClaudeAdapter.list: reports the claude kind', async () => {
  const root = claudeRoot('s1', [line('hello')]);

  const sessions = await new ClaudeAdapter(root).list();

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].agent, 'claude');
  assert.equal(sessions[0].id, 's1');
});

test('ClaudeAdapter.history: most recent page when beforeSeq is null', async () => {
  const root = claudeRoot('s1', [line('one'), line('two'), line('three')]);

  const page = await new ClaudeAdapter(root).history('s1', null, 2);

  assert.deepEqual(page.messages.map((m) => m.seq), [1, 2]);
  assert.equal(page.hasMore, true);
});

test('ClaudeAdapter.history: paging backwards ends with hasMore false', async () => {
  const root = claudeRoot('s1', [line('one'), line('two'), line('three')]);

  const page = await new ClaudeAdapter(root).history('s1', 1, 2);

  assert.deepEqual(page.messages.map((m) => m.seq), [0]);
  assert.equal(page.hasMore, false);
});

test('ClaudeAdapter.history: an unknown session yields an empty page, not a throw', async () => {
  const root = claudeRoot('s1', [line('one')]);

  const page = await new ClaudeAdapter(root).history('nope', null, 50);

  assert.deepEqual(page.messages, []);
  assert.equal(page.hasMore, false);
});

test('ClaudeAdapter.subscribe: replays messages after sinceSeq then stops on unsubscribe', async () => {
  const root = claudeRoot('s1', [line('one'), line('two')]);
  const seen: number[] = [];

  const adapter = new ClaudeAdapter(root);
  const stop = await adapter.subscribe('s1', 0, (event) => {
    if (event.kind === 'message') seen.push(event.seq);
  });
  await new Promise((r) => setTimeout(r, 120));
  stop();

  assert.deepEqual(seen, [1]);
});

test('ClaudeAdapter.send: an unknown session reports failure rather than silently dropping', async () => {
  const root = claudeRoot('s1', [line('one')]);

  await assert.rejects(() => new ClaudeAdapter(root).send('nope', 'hi'));
});

test('ClaudeAdapter.send: a known idle session starts an SDK session and accepts the text', async () => {
  const root = claudeRoot('s1', [line('one')]);
  const adapter = new ClaudeAdapter(root);
  const started: string[] = [];
  adapter.setSessionFactory((sessionId) => {
    started.push(sessionId);
    return { start: async () => {}, send: () => {}, stop: () => {}, onEvent: () => {}, resolvePermission: () => false };
  });

  await adapter.send('s1', 'hello');

  assert.deepEqual(started, ['s1']);
});

test('ClaudeAdapter.send: a second message reuses the same SDK session', async () => {
  const root = claudeRoot('s1', [line('one')]);
  const adapter = new ClaudeAdapter(root);
  let created = 0;
  adapter.setSessionFactory(() => {
    created += 1;
    return { start: async () => {}, send: () => {}, stop: () => {}, onEvent: () => {}, resolvePermission: () => false };
  });

  await adapter.send('s1', 'one');
  await adapter.send('s1', 'two');

  assert.equal(created, 1);
});

test('OpencodeAdapter.list: forwards the client result', async () => {
  const adapter = new OpencodeAdapter(new OpencodeClient('http://127.0.0.1:1'));

  assert.deepEqual(await adapter.list(), []);
});

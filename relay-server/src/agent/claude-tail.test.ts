import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMessagesSince, TranscriptTail } from './claude-tail.js';

const line = (text: string, role: 'user' | 'assistant' = 'user') => JSON.stringify({
  type: role,
  uuid: `id-${text}`,
  timestamp: '2026-08-02T10:00:00.000Z',
  cwd: '/repo',
  isSidechain: false,
  message: { role, content: [{ type: 'text', text }] },
});

function transcriptFile(lines: string[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'tail-')), 's.jsonl');
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

test('readMessagesSince: -1 returns every message', async () => {
  const path = transcriptFile([line('one'), line('two')]);

  const messages = await readMessagesSince(path, -1);

  assert.deepEqual(messages.map((m) => m.seq), [0, 1]);
});

test('readMessagesSince: returns only lines after the given seq', async () => {
  const path = transcriptFile([line('one'), line('two'), line('three')]);

  const messages = await readMessagesSince(path, 0);

  assert.deepEqual(messages.map((m) => m.seq), [1, 2]);
});

test('readMessagesSince: seq stays the absolute line index, not a page offset', async () => {
  // A phone reattaching with sinceSeq=1 must receive seq 2, not seq 0, or the
  // next reattach replays the wrong gap.
  const path = transcriptFile([line('one'), line('two'), line('three')]);

  const messages = await readMessagesSince(path, 1);

  assert.deepEqual(messages.map((m) => m.seq), [2]);
});

test('readMessagesSince: a missing file yields no messages rather than throwing', async () => {
  const messages = await readMessagesSince(join(tmpdir(), 'nope-8f21.jsonl'), -1);

  assert.deepEqual(messages, []);
});

test('TranscriptTail: emits messages appended after it started', async () => {
  const path = transcriptFile([line('one')]);
  const seen: string[] = [];
  const tail = new TranscriptTail(path, 0, (m) => {
    const block = m.blocks[0];
    if (block.kind === 'text') seen.push(block.text);
  }, 20);

  tail.start();
  appendFileSync(path, line('two') + '\n');
  await new Promise((r) => setTimeout(r, 150));
  tail.stop();

  assert.deepEqual(seen, ['two']);
});

test('TranscriptTail: stop() ends emission', async () => {
  const path = transcriptFile([line('one')]);
  const seen: string[] = [];
  const tail = new TranscriptTail(path, 0, () => seen.push('x'), 20);

  tail.start();
  tail.stop();
  appendFileSync(path, line('two') + '\n');
  await new Promise((r) => setTimeout(r, 150));

  assert.deepEqual(seen, []);
});

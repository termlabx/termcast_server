import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sdkMessageToBlocks } from './claude-sdk-session.js';

test('sdkMessageToBlocks: text content becomes a text block', () => {
  const blocks = sdkMessageToBlocks({ content: [{ type: 'text', text: 'hello' }] });

  assert.deepEqual(blocks, [{ kind: 'text', text: 'hello' }]);
});

test('sdkMessageToBlocks: tool_use becomes a toolUse block with a summary', () => {
  const blocks = sdkMessageToBlocks({
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }],
  });

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'toolUse');
  assert.equal((blocks[0] as { summary: string }).summary, 'npm test');
});

test('sdkMessageToBlocks: an oversized tool input is truncated and flagged', () => {
  const blocks = sdkMessageToBlocks({
    content: [{ type: 'tool_use', id: 't', name: 'Write', input: { content: 'x'.repeat(5000) } }],
  });

  const block = blocks[0] as { input: string; truncated: boolean };
  assert.equal(block.truncated, true);
  assert.equal(block.input.length, 2048);
});

test('sdkMessageToBlocks: empty thinking is dropped rather than rendered blank', () => {
  const blocks = sdkMessageToBlocks({ content: [{ type: 'thinking', thinking: '' }] });

  assert.deepEqual(blocks, []);
});

test('sdkMessageToBlocks: an unknown block type is skipped, not fatal', () => {
  const blocks = sdkMessageToBlocks({
    content: [{ type: 'hologram', spin: 3 }, { type: 'text', text: 'kept' }],
  });

  assert.deepEqual(blocks, [{ kind: 'text', text: 'kept' }]);
});

test('sdkMessageToBlocks: a malformed message yields no blocks rather than throwing', () => {
  assert.deepEqual(sdkMessageToBlocks(null), []);
  assert.deepEqual(sdkMessageToBlocks({}), []);
  assert.deepEqual(sdkMessageToBlocks({ content: 'not an array' }), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry } from './registry.js';
import { AttachmentManager } from './attachments.js';
import { ClaudeAdapter } from './claude-adapter.js';
import { encodeAgentFrame, decodeAgentFrame, AGENT_LIST, AGENT_SESSIONS } from './frames.js';
import type { AgentEvent } from './adapter.js';

const line = (text: string) => JSON.stringify({
  type: 'user', uuid: `u-${text}`, timestamp: '2026-08-02T10:00:00.000Z',
  cwd: '/repo', isSidechain: false,
  message: { role: 'user', content: [{ type: 'text', text }] },
});

function fixture(): { root: string; transcript: string } {
  const root = mkdtempSync(join(tmpdir(), 'e2e-agent-'));
  mkdirSync(join(root, '-repo'), { recursive: true });
  const transcript = join(root, '-repo', 'sess.jsonl');
  writeFileSync(transcript, line('first question') + '\n');
  return { root, transcript };
}

test('end to end: an AGENT_LIST frame produces an AGENT_SESSIONS frame with the session', async () => {
  const { root } = fixture();
  const registry = new AgentRegistry([new ClaudeAdapter(root)]);

  const request = decodeAgentFrame(encodeAgentFrame(AGENT_LIST, {}));
  assert.equal(request?.opcode, AGENT_LIST);

  const sessions = await registry.list();
  const response = decodeAgentFrame(encodeAgentFrame(AGENT_SESSIONS, { sessions }));

  assert.equal(response?.opcode, AGENT_SESSIONS);
  const payload = response?.payload as { sessions: Array<{ id: string; title: string }> };
  assert.equal(payload.sessions.length, 1);
  assert.equal(payload.sessions[0].id, 'sess');
  assert.equal(payload.sessions[0].title, 'first question');
});

test('end to end: attaching streams a message appended after the attach', async () => {
  const { root, transcript } = fixture();
  const registry = new AgentRegistry([new ClaudeAdapter(root)]);
  const manager = new AttachmentManager(registry);
  const events: AgentEvent[] = [];

  await manager.attach(1, 'claude', 'sess', 0, (event) => events.push(event));
  appendFileSync(transcript, line('follow-up') + '\n');
  await new Promise((r) => setTimeout(r, 900));
  manager.detachAll();

  const texts = events.flatMap((event) =>
    event.kind === 'message'
      ? event.message.blocks.flatMap((b) => (b.kind === 'text' ? [b.text] : []))
      : []);
  assert.ok(texts.includes('follow-up'), `expected follow-up, saw ${JSON.stringify(texts)}`);
});

test('end to end: detach stops the stream so no events arrive afterwards', async () => {
  const { root, transcript } = fixture();
  const manager = new AttachmentManager(new AgentRegistry([new ClaudeAdapter(root)]));
  const events: AgentEvent[] = [];

  await manager.attach(1, 'claude', 'sess', 0, (event) => events.push(event));
  manager.detach(1);
  const countAtDetach = events.length;
  appendFileSync(transcript, line('after detach') + '\n');
  await new Promise((r) => setTimeout(r, 900));

  assert.equal(events.length, countAtDetach);
});

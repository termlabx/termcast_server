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
import { buildQuestionEvents, askUserQuestionResult } from './claude-sdk-session.js';
import { latestAskUserQuestionIn } from './claude-transcript.js';
import { parseDeskDialog } from './desk-dialog.js';
import { correlateDialog } from './desk-correlate.js';
import { answerKeys } from './desk-question.js';

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

// --- grouped AskUserQuestion ------------------------------------------------

/**
 * The full round trip for the call shape this feature was built for: two
 * questions in one tool call, answered separately from the phone, producing one
 * tool result.
 *
 * Exercised through buildQuestionEvents/askUserQuestionResult rather than a
 * live SDK, because `query()` needs a real Claude process — but these are the
 * two functions canUseTool actually calls, so the contract they encode is the
 * one that ships.
 */
test('e2e: a grouped AskUserQuestion round-trips from tool call to tool result', () => {
  const call = {
    questions: [
      { question: 'Which database?', header: 'DB', multiSelect: false,
        options: [{ label: 'Postgres', description: 'Relational' }, { label: 'SQLite' }] },
      { question: 'Which features?', header: 'Feat', multiSelect: true,
        options: [{ label: 'Auth' }, { label: 'Billing' }] },
    ],
  };

  const infos = buildQuestionEvents(call, { sessionId: 's1', requestId: 'req-1' });
  assert.equal(infos.length, 2);
  assert.equal(infos[0].groupId, infos[1].groupId);
  assert.equal(infos[0].groupCount, 2);
  // Distinct ids, or answering one would resolve the other.
  assert.notEqual(infos[0].requestId, infos[1].requestId);
  // The fidelity the phone renders from, none of which survived the old reader.
  assert.equal(infos[0].options[0].description, 'Relational');
  assert.equal(infos[0].multiSelect, undefined);
  assert.equal(infos[1].multiSelect, true);

  // The phone answers each card; chosen is indexed by group position.
  const chosen = [['Postgres'], ['Auth', 'Billing']];
  assert.deepEqual(askUserQuestionResult(call, chosen), {
    answers: [
      { header: 'DB', question: 'Which database?', selected: ['Postgres'] },
      { header: 'Feat', question: 'Which features?', selected: ['Auth', 'Billing'] },
    ],
  });
});

test('e2e: a desk dialog and its transcript call agree on what was asked', () => {
  const structured = latestAskUserQuestionIn([
    JSON.stringify({
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use', id: 't1', name: 'AskUserQuestion',
          input: {
            questions: [{
              question: 'Which database should the new service use?',
              options: [
                { label: 'Postgres, because the rest of the stack already uses it', description: 'Relational' },
                { label: 'SQLite', description: 'Single file' },
              ],
            }],
          },
        }],
      },
    }),
  ]);
  assert.ok(structured);

  const dialog = parseDeskDialog([
    '─'.repeat(60),
    '  Which database should the new service use?',
    '',
    // Truncated by the pane, exactly as a real TUI would.
    '  ❯ 1. Postgres, because the rest of the stack alr…',
    '    2. SQLite',
    '',
    '  Enter to confirm · Esc to cancel',
  ].join('\n'));
  assert.ok(dialog);

  const merged = correlateDialog(structured, dialog);
  assert.ok(merged, 'the pane and the transcript describe the same dialog');
  assert.equal(merged.options[0].description, 'Relational');

  // And the answer keys off the correlated label, which the pane never carried.
  assert.deepEqual(
    answerKeys(dialog, ['Postgres, because the rest of the stack already uses it'], false, merged),
    ['1'],
  );
});

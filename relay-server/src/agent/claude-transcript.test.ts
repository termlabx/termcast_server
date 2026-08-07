import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, sessionMetaFromTranscript } from './claude-transcript.js';

/**
 * Line shapes here are copied from a real Claude Code transcript, trimmed to
 * the fields the parser actually reads. The transcript format is not a
 * published contract, so these fixtures ARE the contract as far as we're
 * concerned — refresh them from a real session when the format moves.
 */

const userText = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'user',
  uuid: 'u1',
  timestamp: '2026-08-02T10:00:00.000Z',
  sessionId: 's1',
  cwd: '/repo',
  isSidechain: false,
  message: { role: 'user', content: [{ type: 'text', text }] },
  ...extra,
});

const assistantText = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'assistant',
  uuid: 'a1',
  timestamp: '2026-08-02T10:00:01.000Z',
  sessionId: 's1',
  cwd: '/repo',
  isSidechain: false,
  message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] },
  ...extra,
});

test('parseTranscript: a user turn and an assistant turn become two text messages', () => {
  const messages = parseTranscript([userText('hello'), assistantText('hi there')]);

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.deepEqual(messages[0].blocks, [{ kind: 'text', text: 'hello' }]);
  assert.equal(messages[1].role, 'assistant');
  assert.deepEqual(messages[1].blocks, [{ kind: 'text', text: 'hi there' }]);
});

test('parseTranscript: subagent turns are excluded from the main conversation', () => {
  // isSidechain marks Task/Agent tool subagents. Their turns interleave with the
  // main thread in the file; rendering them inline would make the chat look like
  // the agent was talking to itself.
  const messages = parseTranscript([
    userText('main thread'),
    assistantText('subagent chatter', { isSidechain: true }),
  ]);

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].blocks, [{ kind: 'text', text: 'main thread' }]);
});

test('parseTranscript: injected meta turns are not shown as things the user said', () => {
  // isMeta covers system-reminder style injections written with role "user".
  const messages = parseTranscript([
    userText('<system-reminder>be careful</system-reminder>', { isMeta: true }),
    userText('real question'),
  ]);

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].blocks, [{ kind: 'text', text: 'real question' }]);
});

test('parseTranscript: tool-generated user turns are not shown as things the user said', () => {
  // sourceToolUseID means the text was produced by a tool, not typed by a human.
  const messages = parseTranscript([
    userText('output of a hook', { sourceToolUseID: 'toolu_01' }),
    userText('real question'),
  ]);

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].blocks, [{ kind: 'text', text: 'real question' }]);
});

test('parseTranscript: a tool call becomes a toolUse block with a readable summary', () => {
  const line = JSON.stringify({
    type: 'assistant',
    uuid: 'a2',
    timestamp: '2026-08-02T10:00:02.000Z',
    isSidechain: false,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/repo/ConnectView.swift' } }],
    },
  });

  const [message] = parseTranscript([line]);

  assert.deepEqual(message.blocks, [{
    kind: 'toolUse',
    toolUseId: 'toolu_01',
    name: 'Read',
    summary: 'Read ConnectView.swift',
    input: JSON.stringify({ file_path: '/repo/ConnectView.swift' }),
    truncated: false,
  }]);
});

test('parseTranscript: a Bash call summarises with the command, not the file path', () => {
  const line = JSON.stringify({
    type: 'assistant',
    uuid: 'a3',
    isSidechain: false,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_02', name: 'Bash', input: { command: 'npm test' } }],
    },
  });

  const [message] = parseTranscript([line]);

  assert.equal(message.blocks[0].kind, 'toolUse');
  assert.equal((message.blocks[0] as { summary: string }).summary, 'npm test');
});

test('parseTranscript: a tool result becomes a toolResult block carrying its error state', () => {
  const line = JSON.stringify({
    type: 'user',
    uuid: 'u2',
    isSidechain: false,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_01', is_error: true, content: 'File not found' }],
    },
  });

  const [message] = parseTranscript([line]);

  assert.deepEqual(message.blocks, [{
    kind: 'toolResult',
    toolUseId: 'toolu_01',
    ok: false,
    preview: 'File not found',
    truncated: false,
  }]);
});

test('parseTranscript: thinking becomes its own block so the UI can collapse it', () => {
  const line = JSON.stringify({
    type: 'assistant',
    uuid: 'a4',
    isSidechain: false,
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'Let me consider the parser.', signature: 'sig' }],
    },
  });

  const [message] = parseTranscript([line]);

  assert.deepEqual(message.blocks, [{ kind: 'thinking', text: 'Let me consider the parser.' }]);
});

test('parseTranscript: an oversized tool result is truncated and flagged', () => {
  // A tool result routinely contains a whole file. Sending one through the
  // frame path unmodified is both a transport problem and terrible chat UI.
  const huge = 'x'.repeat(5000);
  const line = JSON.stringify({
    type: 'user',
    uuid: 'u3',
    isSidechain: false,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: huge }],
    },
  });

  const [message] = parseTranscript([line]);
  const block = message.blocks[0] as { preview: string; truncated: boolean };

  assert.equal(block.truncated, true);
  assert.equal(block.preview.length, 2048);
});

test('parseTranscript: a torn final line does not lose the messages before it', () => {
  // A live session is appended to while we read it, so the last line is
  // routinely half-written.
  const messages = parseTranscript([userText('hello'), '{"type":"assist']);

  assert.equal(messages.length, 1);
});

test('parseTranscript: seq is the transcript line index so it survives a restart', () => {
  // Leading metadata lines still consume indices: seq must address the file,
  // not the filtered output, or a reattach after restart replays the wrong gap.
  const messages = parseTranscript([
    JSON.stringify({ type: 'mode', mode: 'normal', sessionId: 's1' }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Fix the parser', sessionId: 's1' }),
    userText('hello'),
  ]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].seq, 2);
});

test('parseTranscript: a turn of only redacted thinking does not become an empty bubble', () => {
  // Real transcripts carry thinking blocks whose text is empty and whose only
  // payload is a signature. Rendering those would put blank cards in the chat.
  const line = JSON.stringify({
    type: 'assistant',
    uuid: 'a5',
    isSidechain: false,
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }] },
  });

  assert.deepEqual(parseTranscript([line]), []);
});

test('sessionMetaFromTranscript: prefers the agent-written title', () => {
  const meta = sessionMetaFromTranscript([
    JSON.stringify({ type: 'ai-title', aiTitle: 'Fix the transcript parser', sessionId: 's1' }),
    userText('some much longer opening message that should not win'),
  ]);

  assert.equal(meta.title, 'Fix the transcript parser');
});

test('sessionMetaFromTranscript: falls back to the first real user message, truncated', () => {
  const meta = sessionMetaFromTranscript([
    userText('a'.repeat(200)),
  ]);

  assert.equal(meta.title.length, 80);
  assert.equal(meta.title, 'a'.repeat(79) + '…');
});

test('sessionMetaFromTranscript: the fallback title ignores injected meta turns', () => {
  const meta = sessionMetaFromTranscript([
    userText('<system-reminder>noise</system-reminder>', { isMeta: true }),
    userText('the real first question'),
  ]);

  assert.equal(meta.title, 'the real first question');
});

/**
 * Claude Code writes its own interruption notice as a user turn. On a machine
 * with automation sessions — whose real prompts are all `isMeta` — that notice
 * is the only visible "human" text, so it became the title of 34 of 263 local
 * sessions. Every one of them read "[Request interrupted by user]".
 */
test('sessionMetaFromTranscript: an interruption notice never becomes the title', () => {
  const meta = sessionMetaFromTranscript([
    userText('injected automation prompt', { isMeta: true }),
    userText('[Request interrupted by user]', { interruptedByShutdown: true }),
    assistantText('what the agent actually did'),
  ]);

  assert.equal(meta.title, 'what the agent actually did');
});

test('sessionMetaFromTranscript: an interrupt for tool use is skipped too', () => {
  const meta = sessionMetaFromTranscript([
    userText('[Request interrupted by user for tool use]', { interruptedMessageId: 'msg_01' }),
    userText('the real question'),
  ]);

  assert.equal(meta.title, 'the real question');
});

/** Transcripts written before ~2.1.216 carry no interruption field at all. */
test('sessionMetaFromTranscript: a legacy interrupt notice is recognised by its text', () => {
  const meta = sessionMetaFromTranscript([
    userText('[Request interrupted by user]'),
    userText('the real question'),
  ]);

  assert.equal(meta.title, 'the real question');
});

test('sessionMetaFromTranscript: a session with nothing but an interrupt is honestly untitled', () => {
  const meta = sessionMetaFromTranscript([
    userText('injected automation prompt', { isMeta: true }),
    userText('[Request interrupted by user]', { interruptedByShutdown: true }),
  ]);

  assert.equal(meta.title, 'Untitled session');
});

/** A human writing *about* an interrupt still owns their message. */
test('sessionMetaFromTranscript: text merely mentioning an interrupt still titles the session', () => {
  const meta = sessionMetaFromTranscript([
    userText('why do I keep seeing [Request interrupted by user] everywhere?'),
  ]);

  assert.equal(meta.title, 'why do I keep seeing [Request interrupted by user] everywhere?');
});

/** Same class of bug on the other side: "You've hit your session limit". */
test('sessionMetaFromTranscript: a synthetic assistant turn never becomes the title', () => {
  const meta = sessionMetaFromTranscript([
    userText('injected automation prompt', { isMeta: true }),
    JSON.stringify({
      type: 'assistant', uuid: 'a0', timestamp: '2026-08-02T10:00:00.000Z', sessionId: 's1',
      cwd: '/repo', isSidechain: false,
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit" }] },
    }),
    assistantText('the real opening line'),
  ]);

  assert.equal(meta.title, 'the real opening line');
});

test('sessionMetaFromTranscript: reports cwd, model and last activity for the list row', () => {
  const meta = sessionMetaFromTranscript([userText('hi'), assistantText('hello')]);

  assert.equal(meta.projectPath, '/repo');
  assert.equal(meta.model, 'claude-opus-5');
  assert.equal(meta.lastActiveAt, '2026-08-02T10:00:01.000Z');
  assert.equal(meta.messageCount, 2);
});

test('sessionMetaFromTranscript: an empty transcript yields a placeholder rather than throwing', () => {
  const meta = sessionMetaFromTranscript([]);

  assert.equal(meta.title, 'Untitled session');
  assert.equal(meta.messageCount, 0);
  assert.equal(meta.model, null);
});

test('sessionMetaFromTranscript: a synthetic model never becomes the session model', () => {
  // Claude Code tags system-generated turns ("You've hit your session limit")
  // with model "<synthetic>". Surfacing that as the session's model is wrong.
  const meta = sessionMetaFromTranscript([
    assistantText('real answer'),
    assistantText('You have hit your session limit', {
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'limit' }] },
    }),
  ]);

  assert.equal(meta.model, 'claude-opus-5');
});

test('sessionMetaFromTranscript: titles an agent-driven session from the assistant instead of Untitled', () => {
  // Observer/automation sessions have no human turns at all — every user turn
  // is isMeta. Falling straight through to "Untitled session" wastes a row that
  // may hold hundreds of messages.
  const meta = sessionMetaFromTranscript([
    userText('<observed_from_primary_session>noise', { isMeta: true }),
    assistantText('Recording the observation'),
  ]);

  assert.equal(meta.title, 'Recording the observation');
});

test('sessionMetaFromTranscript: an observer session is not user-initiated', () => {
  // claude-mem and other automation drive Claude Code with prompts written as
  // isMeta user turns, so the session has no human turn at all. Measured over a
  // 294-transcript corpus this separates 184 observer sessions from 83 real
  // ones with no false positives either way.
  const meta = sessionMetaFromTranscript([
    userText('<observed_from_primary_session>noise', { isMeta: true }),
    assistantText('Recording the observation'),
  ]);

  assert.equal(meta.userInitiated, false);
});

test('sessionMetaFromTranscript: a typed turn makes the session user-initiated', () => {
  const meta = sessionMetaFromTranscript([userText('hello'), assistantText('hi there')]);

  assert.equal(meta.userInitiated, true);
});

test('sessionMetaFromTranscript: an interruption notice alone is not a human turn', () => {
  // Claude Code records "the user pressed Esc" as a user turn. Every automation
  // session accumulates them, so counting one as human would unhide them all.
  const meta = sessionMetaFromTranscript([
    userText('<observed_from_primary_session>noise', { isMeta: true }),
    assistantText('working'),
    userText('[Request interrupted by user]'),
  ]);

  assert.equal(meta.userInitiated, false);
});

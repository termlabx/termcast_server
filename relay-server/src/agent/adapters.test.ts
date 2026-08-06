import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter, waitForIdle, paneIsIdle, type PaneProbe } from './claude-adapter.js';
import { OpencodeAdapter, AgentUnsupportedError } from './opencode-adapter.js';
import { OpencodeClient } from './opencode-client.js';
import type { OpencodeEvent, OpencodeEventStream } from './opencode-event-stream.js';
import type { AgentEvent } from './adapter.js';
import type { AgentMessage, AgentQuestionInfo } from './types.js';
import { SessionLiveness } from './session-liveness.js';
import type { DeskRegistry, DeskTarget, DeskEntry } from './desk-target.js';

const deskWith = (target: DeskTarget | null): DeskRegistry => ({
  async lookup() { return target; },
  async list(): Promise<DeskEntry[]> { return []; },
});

const livenessOf = (alive: boolean): SessionLiveness =>
  ({ isAlive: async () => alive }) as unknown as SessionLiveness;

/** Nothing at the desk, nothing running: the plain headless-resume world. */
const headlessDeps = () => ({ desk: deskWith(null), liveness: livenessOf(false), inject: async () => {} });

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

  await assert.rejects(() => new ClaudeAdapter(root, headlessDeps()).send('nope', 'hi'));
});

test('ClaudeAdapter.send: a known idle session starts an SDK session and accepts the text', async () => {
  const root = claudeRoot('s1', [line('one')]);
  const adapter = new ClaudeAdapter(root, headlessDeps());
  const started: string[] = [];
  adapter.setSessionFactory((sessionId) => {
    started.push(sessionId);
    return { start: async () => {}, send: () => {}, stop: () => {}, onEvent: () => {}, resolvePermission: () => false, resolveQuestion: () => false };
  });

  await adapter.send('s1', 'hello');

  assert.deepEqual(started, ['s1']);
});

test('ClaudeAdapter.send: a second message reuses the same SDK session', async () => {
  const root = claudeRoot('s1', [line('one')]);
  const adapter = new ClaudeAdapter(root, headlessDeps());
  let created = 0;
  adapter.setSessionFactory(() => {
    created += 1;
    return { start: async () => {}, send: () => {}, stop: () => {}, onEvent: () => {}, resolvePermission: () => false, resolveQuestion: () => false };
  });

  await adapter.send('s1', 'one');
  await adapter.send('s1', 'two');

  assert.equal(created, 1);
});

test('ClaudeAdapter.send: a reachable session injects into its pane instead of starting an SDK session', async () => {
  const root = claudeRoot('s1', [line('one')]);
  const injected: string[] = [];
  let sdkStarted = false;

  const adapter = new ClaudeAdapter(root, {
    desk: deskWith({ paneId: '%3', mux: 'tmux', status: 'unknown' }),
    liveness: livenessOf(true),
    inject: async (paneId, text) => { injected.push(`${paneId}:${text}`); },
    watchStatus: async () => {},
  });
  adapter.setSessionFactory(() => {
    sdkStarted = true;
    return { start: async () => {}, send: () => {}, stop: () => {}, onEvent: () => {}, resolvePermission: () => false, resolveQuestion: () => false };
  });

  await adapter.send('s1', 'hello');

  assert.deepEqual(injected, ['%3:hello']);
  assert.equal(sdkStarted, false);
});

test('ClaudeAdapter.send: a desk send ends the turn once the pane settles', async () => {
  const root = claudeRoot('s1', [line('one')]);
  const statuses: string[] = [];

  const adapter = new ClaudeAdapter(root, {
    desk: deskWith({ paneId: '%3', mux: 'tmux', status: 'unknown' }),
    liveness: livenessOf(true),
    inject: async () => {},
    watchStatus: async () => {},
  });
  adapter.setEventSink((event) => {
    if (event.kind === 'status') statuses.push(event.status);
  });

  await adapter.send('s1', 'hello');
  // Give the fire-and-forget watcher a beat to finish.
  await new Promise((r) => setTimeout(r, 50));

  assert.deepEqual(statuses, ['turn_end']);
});

test('ClaudeAdapter.send: a watcher that throws still ends the turn', async () => {
  // A vanished multiplexer must not pin the phone on "Working…" forever.
  const root = claudeRoot('s1', [line('one')]);
  const statuses: string[] = [];

  const adapter = new ClaudeAdapter(root, {
    desk: deskWith({ paneId: '%3', mux: 'tmux', status: 'unknown' }),
    liveness: livenessOf(true),
    inject: async () => {},
    watchStatus: async () => { throw new Error('pane gone'); },
  });
  adapter.setEventSink((event) => {
    if (event.kind === 'status') statuses.push(event.status);
  });

  await adapter.send('s1', 'hello');
  await new Promise((r) => setTimeout(r, 50));

  assert.deepEqual(statuses, ['turn_end']);
});

test('ClaudeAdapter.send: a busy desk agent reports rather than interleaving', async () => {
  const root = claudeRoot('s1', [line('one')]);
  const adapter = new ClaudeAdapter(root, {
    desk: deskWith({ paneId: '%3', mux: 'herdr', status: 'working' }),
    liveness: livenessOf(true),
    inject: async () => { throw new Error('must not inject'); },
  });

  await assert.rejects(() => adapter.send('s1', 'hello'), /busy/i);
});

/** Two-sample pane probe: each call returns the next scripted frame. */
const scriptedProbe = (frames: (string | null)[], inMode = false): PaneProbe => {
  let call = 0;
  return async () => {
    const content = frames[Math.min(call++, frames.length - 1)];
    return content === null ? null : { inMode, content };
  };
};

test('paneIsIdle: a repainting pane is busy', async () => {
  // A working agent animates a spinner and streams tokens, so two captures a
  // beat apart differ. This is the signal `cursor_x == 0` never gave us: every
  // TUI parks its cursor inside an input box, so the old probe read "busy"
  // forever and the phone's Working spinner only cleared at the 10 min bound.
  const busy = ['✽ Nucleating… (8m 40s · ↓ 33.2k tokens)', '· Nucleating… (8m 41s · ↓ 33.3k tokens)'];
  assert.equal(await paneIsIdle('%0', scriptedProbe(busy), 0), false);
});

test('paneIsIdle: a settled pane is idle even with the cursor mid-line', async () => {
  const settled = ['│ > Try "how does X work?"                    │'];
  assert.equal(await paneIsIdle('%1', scriptedProbe(settled), 0), true);
});

test('paneIsIdle: a pane in copy mode is busy, so we never inject into a scrollback view', async () => {
  assert.equal(await paneIsIdle('%2', scriptedProbe(['same'], true), 0), false);
});

test('paneIsIdle: an unreadable pane reads idle rather than blocking the phone', async () => {
  assert.equal(await paneIsIdle('%9', scriptedProbe([null]), 0), true);
});

test('waitForIdle: requires two consecutive idle reads, so a blink does not end the turn', async () => {
  // idle, busy, idle, idle → must resolve only after the run of two.
  const samples: boolean[] = [true, false, true, true];
  let calls = 0;

  await waitForIdle(async () => samples[calls++], { settleMs: 0, pollMs: 5, timeoutMs: 10_000 });

  assert.equal(calls, 4);
});

test('waitForIdle: a never-idle pane resolves when the timeout elapses (bounded watcher)', async () => {
  await waitForIdle(async () => true, { settleMs: 0, pollMs: 5, timeoutMs: 20 });
});

test('ClaudeAdapter.send: a session nothing holds falls back to the SDK', async () => {
  // multiplexer: none has no injection mechanism at all.
  const root = claudeRoot('s1', [line('one')]);
  const adapter = new ClaudeAdapter(root, headlessDeps());
  let sdkStarted = false;

  adapter.setSessionFactory(() => {
    sdkStarted = true;
    return { start: async () => {}, send: () => {}, stop: () => {}, onEvent: () => {}, resolvePermission: () => false, resolveQuestion: () => false };
  });

  await adapter.send('s1', 'hello');

  assert.equal(sdkStarted, true);
});

test('OpencodeAdapter.list: forwards the client result', async () => {
  const adapter = new OpencodeAdapter(new OpencodeClient('http://127.0.0.1:1'));

  assert.deepEqual(await adapter.list(), []);
});

/** A client stub whose transcript the test can mutate between polls. */
function transcriptStub(script: { messages: AgentMessage[]; running: boolean }[]) {
  let tick = 0;
  return {
    listTranscript: async () => script[Math.min(tick++, script.length - 1)],
  } as unknown as OpencodeClient;
}

const assistant = (id: string, text: string): AgentMessage => ({
  id, seq: 1, role: 'assistant', timestamp: null, blocks: [{ kind: 'text', text }],
});

const queuedUser = (id: string, text: string, pending: boolean): AgentMessage => ({
  id, seq: 1, role: 'user', timestamp: null, blocks: [{ kind: 'text', text }], pending,
});

const questionToolUse = (id: string, input: string): AgentMessage => ({
  id: `q-${id}`, seq: 1, role: 'assistant', timestamp: null,
  blocks: [{ kind: 'toolUse', toolUseId: id, name: 'question', summary: '', input, truncated: false }],
});

test('OpencodeAdapter.subscribe: re-emits a message whose content grew', async () => {
  // opencode creates the assistant message when the turn starts and appends to
  // it for as long as the model is producing. Keyed on seq alone the reply was
  // emitted once — empty — and never again, so the phone showed a turn that
  // hung with no output.
  const client = transcriptStub([
    { messages: [assistant('msg_1', 'Let me')], running: true },
    { messages: [assistant('msg_1', 'Let me check that')], running: true },
    { messages: [assistant('msg_1', 'Let me check that file.')], running: false },
  ]);
  const seen: string[] = [];

  const stop = await new OpencodeAdapter(client).subscribe('ses_abc', -1, (event) => {
    if (event.kind === 'message') {
      const block = event.message.blocks[0];
      if (block.kind === 'text') seen.push(block.text);
    }
  });
  await new Promise((r) => setTimeout(r, 2400));
  stop();

  assert.deepEqual(seen, ['Let me', 'Let me check that', 'Let me check that file.']);
});

test('OpencodeAdapter.subscribe: does not re-emit an unchanged message', async () => {
  const client = transcriptStub([{ messages: [assistant('msg_1', 'done')], running: false }]);
  let count = 0;

  const stop = await new OpencodeAdapter(client).subscribe('ses_abc', -1, (event) => {
    if (event.kind === 'message') count += 1;
  });
  await new Promise((r) => setTimeout(r, 2400));
  stop();

  assert.equal(count, 1);
});

test('OpencodeAdapter.subscribe: reports turn start and end', async () => {
  // Without these the phone's "Working…" bar was set on send and never cleared,
  // because the opencode adapter emitted no status event at all.
  const client = transcriptStub([
    { messages: [assistant('msg_1', 'thinking')], running: true },
    { messages: [assistant('msg_1', 'answer')], running: false },
  ]);
  const statuses: string[] = [];

  const stop = await new OpencodeAdapter(client).subscribe('ses_abc', -1, (event) => {
    if (event.kind === 'status') statuses.push(event.status);
  });
  await new Promise((r) => setTimeout(r, 1600));
  stop();

  assert.deepEqual(statuses, ['turn_start', 'turn_end']);
});

test('OpencodeAdapter.subscribe: attaching to an idle session announces nothing', async () => {
  // "idle" on the first tick would race the send — the poll can land between
  // the phone raising its spinner and opencode recording the prompt, and would
  // then clear the spinner the user had just triggered.
  const client = transcriptStub([{ messages: [assistant('msg_1', 'done')], running: false }]);
  const statuses: string[] = [];

  const stop = await new OpencodeAdapter(client).subscribe('ses_abc', -1, (event) => {
    if (event.kind === 'status') statuses.push(event.status);
  });
  await new Promise((r) => setTimeout(r, 1600));
  stop();

  assert.deepEqual(statuses, []);
});

test('OpencodeAdapter.subscribe: re-emits a queued user turn once it is answered', async () => {
  // A prompt sent while opencode is busy is queued: the user message exists
  // immediately, flagged pending. The flag is part of the emit fingerprint, so
  // the same id arriving with pending=false later must re-emit — otherwise the
  // phone keeps the "queued" badge on a turn that has already been answered.
  const client = transcriptStub([
    { messages: [queuedUser('u_1', 'do the thing', true)], running: true },
    { messages: [queuedUser('u_1', 'do the thing', false)], running: false },
  ]);
  const pending: boolean[] = [];

  const stop = await new OpencodeAdapter(client).subscribe('ses_abc', -1, (event) => {
    if (event.kind === 'message' && event.message.id === 'u_1') {
      pending.push(event.message.pending ?? false);
    }
  });
  await new Promise((r) => setTimeout(r, 1600));
  stop();

  assert.deepEqual(pending, [true, false]);
});

test('OpencodeAdapter.subscribe: emits a question once per toolUse id', async () => {
  // The seen-set must live in the subscription: the poll re-reads the same
  // transcript repeatedly, and a module-global set would (a) leak across
  // sessions and (b) never be pruned.
  const client = {
    listTranscript: async () => ({
      messages: [questionToolUse('q_1', '{"prompt":"Pick one","options":[{"label":"A"},{"label":"B"}]}')],
      running: false,
    }),
    listQuestions: async () => [],
  } as unknown as OpencodeClient;
  const questions: AgentQuestionInfo[] = [];
  const stop = await new OpencodeAdapter(client).subscribe('ses_abc', -1, (event) => {
    if (event.kind === 'question') questions.push(event.request);
  });
  await new Promise((r) => setTimeout(r, 1600));
  stop();

  assert.equal(questions.length, 1);
  assert.equal(questions[0].requestId, 'q_1');
  assert.equal(questions[0].kind, 'select');
  assert.deepEqual(questions[0].options, [
    { label: 'A', description: undefined },
    { label: 'B', description: undefined },
  ]);
});

test('OpencodeAdapter.subscribe: retries listQuestions before dropping an unparseable question', async () => {
  // opencode can record the tool-use block before the question API has it; the
  // adapter must fall back to listQuestions within a bounded retry, not guess.
  let calls = 0;
  const client = {
    listTranscript: async () => ({ messages: [questionToolUse('q_1', 'not-json')], running: false }),
    listQuestions: async () => {
      calls += 1;
      return calls >= 2
        ? [{ requestId: 'q_1', sessionId: 'ses_abc', agent: 'opencode', prompt: 'Recovered', kind: 'select' as const, options: [], createdAt: '' }]
        : [];
    },
  } as unknown as OpencodeClient;
  const questions: AgentQuestionInfo[] = [];
  const stop = await new OpencodeAdapter(client).subscribe('ses_abc', -1, (event) => {
    if (event.kind === 'question') questions.push(event.request);
  });
  await new Promise((r) => setTimeout(r, 1600));
  stop();

  assert.ok(calls >= 2, `expected at least 2 listQuestions calls, got ${calls}`);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].prompt, 'Recovered');
});

test('OpencodeAdapter.subscribe: a read failure clears a stuck working state', async () => {
  // `void transcript()` used to swallow listTranscript rejections: the phone's
  // "Working…" spun forever because no turn_end (or error) ever arrived. A
  // failure while a turn is being tracked must emit one error status.
  let tick = 0;
  const client = {
    listTranscript: async () => {
      tick += 1;
      if (tick === 1) return { messages: [], running: true };
      if (tick === 2) throw new Error('connection lost');
      return { messages: [assistant('msg_1', 'answer')], running: false };
    },
    listQuestions: async () => [],
  } as unknown as OpencodeClient;
  const statuses: { status: string; detail?: string }[] = [];
  const stop = await new OpencodeAdapter(client).subscribe('ses_abc', -1, (event) => {
    if (event.kind === 'status') statuses.push({ status: event.status, detail: event.detail });
  });
  await new Promise((r) => setTimeout(r, 2600));
  stop();

  assert.deepEqual(statuses.map((s) => s.status), ['turn_start', 'error']);
  assert.match(statuses[1].detail ?? '', /connection lost/);
});

test('OpencodeAdapter.subscribe: a TUI draft that is cleared ends its working state', async () => {
  // The draft poller shows "Working…" when someone types into the laptop TUI,
  // but nothing ended that state: only the transcript's running flag emits
  // turn_end, and a draft that is never submitted never flips it. A leftover
  // line in the desk's input box pinned the phone to Working indefinitely.
  const drafts = ['typing a th', ''];
  let poll = 0;
  const client = {
    listTranscript: async () => ({ messages: [], running: false }),
    listQuestions: async () => [],
    getDraftPrompt: async () => drafts[Math.min(poll++, drafts.length - 1)],
  } as unknown as OpencodeClient;
  const statuses: string[] = [];
  const stop = await new OpencodeAdapter(client).subscribe('ses_abc', -1, (event) => {
    if (event.kind === 'status') statuses.push(event.status);
  });
  await new Promise((r) => setTimeout(r, 4700));
  stop();

  assert.deepEqual(statuses, ['turn_start', 'turn_end']);
});

test('OpencodeAdapter.subscribe: a growing TUI draft is sent as a replacement, not an append', async () => {
  // getDraftPrompt returns the whole input box every poll. Sent as plain deltas
  // the phone appends them, so "typ" then "typing" rendered as "typtyping".
  const drafts = ['typ', 'typing'];
  let poll = 0;
  const client = {
    listTranscript: async () => ({ messages: [], running: false }),
    listQuestions: async () => [],
    getDraftPrompt: async () => drafts[Math.min(poll++, drafts.length - 1)],
  } as unknown as OpencodeClient;
  const deltas: { text: string; replace?: boolean }[] = [];
  const stop = await new OpencodeAdapter(client).subscribe('ses_abc', -1, (event) => {
    if (event.kind === 'delta') deltas.push({ text: event.text, replace: event.replace });
  });
  await new Promise((r) => setTimeout(r, 4700));
  stop();

  assert.deepEqual(deltas, [{ text: 'typ', replace: true }, { text: 'typing', replace: true }]);
});

test('OpencodeAdapter.subscribe: an empty TUI draft never starts a working state', async () => {
  const client = {
    listTranscript: async () => ({ messages: [], running: false }),
    listQuestions: async () => [],
    getDraftPrompt: async () => '',
  } as unknown as OpencodeClient;
  const statuses: string[] = [];
  const stop = await new OpencodeAdapter(client).subscribe('ses_abc', -1, (event) => {
    if (event.kind === 'status') statuses.push(event.status);
  });
  await new Promise((r) => setTimeout(r, 2600));
  stop();

  assert.deepEqual(statuses, []);
});

// --- signal-driven subscribe (the /api/event routing split) ----------------

/** A controllable stand-in for OpencodeEventStream used by the opencode adapter. */
function streamStub() {
  const listeners = new Set<(e: OpencodeEvent) => void>();
  const connection = new Set<(connected: boolean) => void>();
  let connected = true;
  return {
    setConnected(v: boolean) { connected = v; for (const cb of connection) cb(v); },
    isConnected: () => connected,
    subscribe: (_id: string, cb: (e: OpencodeEvent) => void) => { listeners.add(cb); return () => listeners.delete(cb); },
    onConnectionChange: (cb: (c: boolean) => void) => { connection.add(cb); return () => connection.delete(cb); },
    emit: (e: OpencodeEvent) => { for (const cb of listeners) cb(e); },
  };
}

function countingTranscript() {
  let calls = 0;
  return {
    get calls() { return calls; },
    listTranscript: async () => { calls += 1; return { messages: [] as AgentMessage[], running: false }; },
  };
}

const structural = (type: string): OpencodeEvent => ({ type, data: { sessionID: 'ses_abc' } });
const delta = (messageId: string, text: string): OpencodeEvent => ({
  type: 'session.next.text.delta',
  data: { sessionID: 'ses_abc', assistantMessageID: messageId, delta: text },
});

test('OpencodeAdapter.subscribe: a burst of structural events produces one debounced fetch', async () => {
  const client = countingTranscript();
  const stream = streamStub();
  const stop = await new OpencodeAdapter(client as unknown as OpencodeClient, stream as unknown as OpencodeEventStream).subscribe('ses_abc', -1, () => {});
  await new Promise((r) => setTimeout(r, 10));
  const before = client.calls;

  // A whole turn's worth of structural events arrive back-to-back.
  stream.emit(structural('session.next.prompt.admitted'));
  stream.emit(structural('session.next.step.started'));
  stream.emit(structural('session.next.step.ended'));
  stream.emit(structural('session.next.text.ended'));
  await new Promise((r) => setTimeout(r, 200));   // lone debounce window

  // Initial fill + exactly one debounced reconcile, not five.
  assert.equal(client.calls - before, 1);
  stop();
});

test('OpencodeAdapter.subscribe: deltas produce no transcript fetch and one coalesced emit', async () => {
  const client = countingTranscript();
  const stream = streamStub();
  const deltas: AgentEvent[] = [];
  const stop = await new OpencodeAdapter(client as unknown as OpencodeClient, stream as unknown as OpencodeEventStream).subscribe('ses_abc', -1, (e) => {
    if (e.kind === 'delta') deltas.push(e);
  });
  await new Promise((r) => setTimeout(r, 10));
  const before = client.calls;

  // Sixteen deltas — the measured count for a short reply.
  for (const word of ['One', ' Two', ' Three', ' Four']) stream.emit(delta('msg_7', word));
  await new Promise((r) => setTimeout(r, 120));   // delta flush window

  assert.equal(client.calls, before, 'deltas never touch the transcript');
  assert.equal(deltas.length, 1, 'deltas coalesce into a single relay frame');
  const d = deltas[0];
  assert.equal(d.kind, 'delta');
  assert.equal((d as { messageId: string }).messageId, 'msg_7');
  assert.equal((d as { text: string }).text, 'One Two Three Four');
  stop();
});

test('OpencodeAdapter.subscribe: an unavailable stream falls back to the poll and still emits', async () => {
  const client = countingTranscript();
  const stream = streamStub();
  stream.setConnected(false);
  const stop = await new OpencodeAdapter(client as unknown as OpencodeClient, stream as unknown as OpencodeEventStream).subscribe('ses_abc', -1, () => {});
  await new Promise((r) => setTimeout(r, 1200));   // more than the 1 s poll
  stop();

  assert.ok(client.calls >= 2, 'no stream available → the backstop poll still reads');
});

test('claude send: injects into the desk pane when the session is idle there', async () => {
  const injected: Array<{ paneId: string; text: string }> = [];
  const adapter = new ClaudeAdapter('/projects', {
    desk: deskWith({ paneId: 'w1:p1', mux: 'herdr', status: 'idle' }),
    liveness: livenessOf(true),
    inject: async (paneId, text) => { injected.push({ paneId, text }); },
  });

  await adapter.send('s1', 'hello123');

  assert.deepEqual(injected, [{ paneId: 'w1:p1', text: 'hello123' }]);
});

test('claude send: refuses while the desk agent is working', async () => {
  const adapter = new ClaudeAdapter('/projects', {
    desk: deskWith({ paneId: 'w1:p1', mux: 'herdr', status: 'working' }),
    liveness: livenessOf(true),
    inject: async () => { throw new Error('must not inject'); },
  });

  await assert.rejects(() => adapter.send('s1', 'hello123'), /busy at the desk/);
});

test('claude send: refuses while the desk agent is blocked on a permission', async () => {
  const adapter = new ClaudeAdapter('/projects', {
    desk: deskWith({ paneId: 'w1:p1', mux: 'herdr', status: 'blocked' }),
    liveness: livenessOf(true),
    inject: async () => { throw new Error('must not inject'); },
  });

  await assert.rejects(() => adapter.send('s1', 'hello123'), /busy at the desk/);
});

test('claude send: refuses rather than going headless when alive but unreachable', async () => {
  let headless = false;
  const adapter = new ClaudeAdapter('/projects', {
    desk: deskWith(null),
    liveness: livenessOf(true),
    inject: async () => {},
  });
  adapter.setSessionFactory(() => {
    headless = true;
    return { start: async () => {}, send: () => {}, stop: () => {}, onEvent: () => {},
             resolvePermission: () => false, resolveQuestion: () => false };
  });

  await assert.rejects(() => adapter.send('s1', 'hello123'), /open in a terminal/);
  assert.equal(headless, false);
});

test('claude send: resumes headlessly when nothing holds the session', async () => {
  const sent: string[] = [];
  const adapter = new ClaudeAdapter('/projects', {
    desk: deskWith(null),
    liveness: livenessOf(false),
    inject: async () => {},
  });
  adapter.setSessionFactory(() => ({
    start: async () => {}, send: (t: string) => { sent.push(t); }, stop: () => {},
    onEvent: () => {}, resolvePermission: () => false, resolveQuestion: () => false,
  }));
  adapter.setTranscriptLookup(async () => '/projects/p/s1.jsonl');

  await adapter.send('s1', 'hello123');

  assert.deepEqual(sent, ['hello123']);
});

const stubClient = (sink: { sent: Array<[string, string]> }) => ({
  sendMessage: async (id: string, text: string) => { sink.sent.push([id, text]); },
}) as unknown as ConstructorParameters<typeof OpencodeAdapter>[0];

test('opencode send: injects into the desk pane instead of posting headlessly', async () => {
  const posted = { sent: [] as Array<[string, string]> };
  const injected: Array<{ paneId: string; text: string }> = [];
  const adapter = new OpencodeAdapter(stubClient(posted), undefined, {
    desk: deskWith({ paneId: 'w3:p1', mux: 'herdr', status: 'idle' }),
    liveness: livenessOf(true),
    inject: async (paneId, text) => { injected.push({ paneId, text }); },
    watchStatus: async () => {},
  });

  await adapter.send('ses_1', 'hello123');

  assert.deepEqual(injected, [{ paneId: 'w3:p1', text: 'hello123' }]);
  assert.deepEqual(posted.sent, [], 'must not also post the prompt headlessly');
});

test('opencode send: refuses while the desk agent is working', async () => {
  const posted = { sent: [] as Array<[string, string]> };
  const adapter = new OpencodeAdapter(stubClient(posted), undefined, {
    desk: deskWith({ paneId: 'w3:p1', mux: 'herdr', status: 'working' }),
    liveness: livenessOf(true),
    inject: async () => { throw new Error('must not inject'); },
  });

  await assert.rejects(() => adapter.send('ses_1', 'hello123'), /busy at the desk/);
  assert.deepEqual(posted.sent, []);
});

test('opencode send: refuses rather than posting when alive but unreachable', async () => {
  const posted = { sent: [] as Array<[string, string]> };
  const adapter = new OpencodeAdapter(stubClient(posted), undefined, {
    desk: deskWith(null),
    liveness: livenessOf(true),
    inject: async () => {},
  });

  await assert.rejects(() => adapter.send('ses_1', 'hello123'), /open in a terminal/);
  assert.deepEqual(posted.sent, [], 'a live TUI must not be bypassed by a headless post');
});

test('opencode send: posts headlessly when nothing holds the session', async () => {
  const posted = { sent: [] as Array<[string, string]> };
  const adapter = new OpencodeAdapter(stubClient(posted), undefined, {
    desk: deskWith(null),
    liveness: livenessOf(false),
    inject: async () => {},
  });

  await adapter.send('ses_1', 'hello123');

  assert.deepEqual(posted.sent, [['ses_1', 'hello123']]);
});

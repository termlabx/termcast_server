import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter, waitForIdle } from './claude-adapter.js';
import { OpencodeAdapter, AgentUnsupportedError } from './opencode-adapter.js';
import { OpencodeClient } from './opencode-client.js';
import type { OpencodeEvent, OpencodeEventStream } from './opencode-event-stream.js';
import type { AgentEvent } from './adapter.js';
import type { AgentMessage } from './types.js';

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
    return { start: async () => {}, send: () => {}, stop: () => {}, onEvent: () => {}, resolvePermission: () => false, resolveQuestion: () => false };
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
    return { start: async () => {}, send: () => {}, stop: () => {}, onEvent: () => {}, resolvePermission: () => false, resolveQuestion: () => false };
  });

  await adapter.send('s1', 'one');
  await adapter.send('s1', 'two');

  assert.equal(created, 1);
});

test('ClaudeAdapter.send: a live session injects into its pane instead of starting an SDK session', async () => {
  const root = claudeRoot('s1', [line('one')]);
  const adapter = new ClaudeAdapter(root);
  const injected: string[] = [];
  let sdkStarted = false;

  adapter.setIdleWaiter(async () => {});
  adapter.setLiveLookup(() => [{ sessionId: 's1', cwd: '/repo', transcriptPath: '', pid: process.pid, paneId: '%3' }]);
  adapter.setInjector(async (paneId, text) => { injected.push(`${paneId}:${text}`); return true; });
  adapter.setSessionFactory(() => {
    sdkStarted = true;
    return { start: async () => {}, send: () => {}, stop: () => {}, onEvent: () => {}, resolvePermission: () => false, resolveQuestion: () => false };
  });

  await adapter.send('s1', 'hello');

  assert.deepEqual(injected, ['%3:hello']);
  assert.equal(sdkStarted, false);
});

test('ClaudeAdapter.send: a live session ends the turn once its pane is idle again', async () => {
  const root = claudeRoot('s1', [line('one')]);
  const adapter = new ClaudeAdapter(root);
  const statuses: string[] = [];
  let idleSamples = 0;

  adapter.setEventSink((event) => {
    if (event.kind === 'status') statuses.push(event.status);
  });
  adapter.setIdleWaiter(async (sample) => {
    // Two samples: busy, then idle.
    await sample();
    await sample();
  });
  adapter.setLiveLookup(() => [{ sessionId: 's1', cwd: '/repo', transcriptPath: '', pid: process.pid, paneId: '%3' }]);
  adapter.setInjector(async () => { idleSamples += 1; return true; });
  adapter.setSessionFactory(() => {
    return { start: async () => {}, send: () => {}, stop: () => {}, onEvent: () => {}, resolvePermission: () => false, resolveQuestion: () => false };
  });

  await adapter.send('s1', 'hello');
  // Give the fire-and-forget watcher a beat to finish.
  await new Promise((r) => setTimeout(r, 50));

  assert.deepEqual(statuses, ['turn_end']);
});

test('ClaudeAdapter.send: a busy pane reports rather than interleaving with the desk', async () => {
  const root = claudeRoot('s1', [line('one')]);
  const adapter = new ClaudeAdapter(root);
  adapter.setLiveLookup(() => [{ sessionId: 's1', cwd: '/repo', transcriptPath: '', pid: process.pid, paneId: '%3' }]);
  adapter.setInjector(async () => false);

  await assert.rejects(() => adapter.send('s1', 'hello'), /busy/i);
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

test('ClaudeAdapter.send: a live session with no pane falls back to the SDK', async () => {
  // multiplexer: none has no injection mechanism at all.
  const root = claudeRoot('s1', [line('one')]);
  const adapter = new ClaudeAdapter(root);
  let sdkStarted = false;

  adapter.setLiveLookup(() => [{ sessionId: 's1', cwd: '/repo', transcriptPath: '', pid: process.pid, paneId: null }]);
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

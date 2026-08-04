import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpencodeEventStream, opencodeEventSessionId, type EventStreamScheduler, type OpencodeEvent } from './opencode-event-stream.js';

/** A clock whose timers the test drives forward exactly when it wants. */
function makeClock() {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { fn: () => void; at: number }>();
  const scheduler: EventStreamScheduler = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      pending.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (id) => { pending.delete(id as number); },
  };
  return {
    scheduler,
    advance(ms: number) {
      now += ms;
      for (;;) {
        let nextId: number | null = null;
        let at = Infinity;
        for (const [id, t] of pending) {
          if (t.at <= now && t.at < at) { nextId = id; at = t.at; }
        }
        if (nextId === null) break;
        const t = pending.get(nextId)!;
        pending.delete(nextId);
        t.fn();
      }
    },
  };
}

/**
 * A stub `openStream` speaking `text/event-stream`. Each call spins a fresh
 * ReadableStream seeded with static bytes, then closes upon the **second-abort**
 * so a watchdog-aborted read unwinds cleanly into a reconnect (silence) or an
 * EOF reconnect happens naturally on close.
 */
function streamHarness(chunks: () => Uint8Array[]) {
  let opens = 0;
  return {
    opens: () => opens,
    openStream: async (url: string, signal: AbortSignal) => {
      opens += 1;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) { controller = ctrl; },
        pull(ctrl) {
          for (const c of chunks()) ctrl.enqueue(c);
          ctrl.close();
        },
      });
      // Surface a watchdog abort as a clean close so the read loop unwinds.
      signal.addEventListener('abort', () => { try { controller.close(); } catch { /* already closed */ } });
      return stream;
    },
  };
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/** Yields one SSE frame; used as a chunk so a single frame may split later. */
const frame = (body: string) => utf8(`data: ${body}\n\n`);

/** Flush pending microtasks so the async connect/read settle. */
function drain(): Promise<void> {
  return new Promise((r) => setImmediate(() => r()));
}

function subscribe(stream: OpencodeEventStream, id: string, seen: OpencodeEvent[]) {
  return stream.subscribe(id, (e) => seen.push(e));
}

test('opencodeEventSessionId: prefers durable.aggregateID, falls back to data.sessionID', () => {
  assert.equal(opencodeEventSessionId({ type: 'x', durable: { aggregateID: 'agg' }, data: { sessionID: 'ses' } }), 'agg');
  assert.equal(opencodeEventSessionId({ type: 'x', data: { sessionID: 'ses' } }), 'ses');
  assert.equal(opencodeEventSessionId({ type: 'x' }), undefined);
});

test('routes frames to the subscriber owning the session id', async () => {
  const clock = makeClock();
  const harness = streamHarness(() => [
    frame(JSON.stringify({ type: 'session.next.prompt.admitted', data: { sessionID: 'ses_a' } })),
    frame(JSON.stringify({ type: 'session.next.text.delta', durable: { aggregateID: 'ses_b' }, data: { sessionID: 'ses_b', assistantMessageID: 'm1', delta: 'One' } })),
  ]);
  const stream = new OpencodeEventStream({
    baseUrl: 'http://stub', scheduler: clock.scheduler,
    openStream: harness.openStream, watchdogMs: 40_000, recheckMs: 2_000,
  });
  const a: OpencodeEvent[] = [];
  const b: OpencodeEvent[] = [];
  const unsubscribeA = subscribe(stream, 'ses_a', a);
  const unsubscribeB = subscribe(stream, 'ses_b', b);
  await drain(); await drain();

  assert.equal(a.length, 1);
  assert.equal(a[0].type, 'session.next.prompt.admitted');
  assert.equal(b.length, 1);
  assert.equal(b[0].type, 'session.next.text.delta');
  unsubscribeA(); unsubscribeB();
});

test('an event for an unwatched session is dropped, not delivered', async () => {
  const clock = makeClock();
  let opens = 0;
  const s = new OpencodeEventStream({
    baseUrl: 'http://x', scheduler: clock.scheduler, watchdogMs: 40_000,
    openStream: async () => {
      opens += 1;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
      controller.enqueue(frame(JSON.stringify({ type: 'session.next.text.delta', data: { sessionID: 'ses_other' } })));
      controller.close();
      return stream;
    },
  });
  const seen: OpencodeEvent[] = [];
  const unsubscribe = subscribe(s, 'ses_watched', seen);
  await drain(); await drain();

  assert.equal(seen.length, 0);
  unsubscribe();
});

test('an event carrying no session id wakes every subscriber', async () => {
  const clock = makeClock();
  const s = new OpencodeEventStream({
    baseUrl: 'http://x', scheduler: clock.scheduler, watchdogMs: 40_000,
    openStream: async () => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
      controller.enqueue(frame(JSON.stringify({ type: 'server.connected' })));
      controller.close();
      return stream;
    },
  });
  const one: OpencodeEvent[] = [];
  const two: OpencodeEvent[] = [];
  const u1 = subscribe(s, 'ses_a', one);
  const u2 = subscribe(s, 'ses_b', two);
  await drain(); await drain();

  assert.equal(one.length, 1);
  assert.equal(two.length, 1);
  u1(); u2();
});

test('comments and multiline payloads parse; heartbeats never reach subscribers', async () => {
  const clock = makeClock();
  const s = new OpencodeEventStream({
    baseUrl: 'http://x', scheduler: clock.scheduler, watchdogMs: 40_000,
    openStream: async () => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
      // A single chunk split an SSE frame across two deliveries, plus a heartbeat comment.
      controller.enqueue(utf8(': heartbeat\n\n'));
      controller.enqueue(utf8('data: {"type":"session.next.step.started"'));
      controller.enqueue(utf8(',"data":{"sessionID":"ses_a"}}\n\n'));
      controller.close();
      return stream;
    },
  });
  const seen: OpencodeEvent[] = [];
  const unsubscribe = subscribe(s, 'ses_a', seen);
  await drain(); await drain();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'session.next.step.started');
  unsubscribe();
});

test('the connection opens on the first subscriber and closes on the last', async () => {
  const clock = makeClock();
  const harness = streamHarness(() => []);
  const s = new OpencodeEventStream({
    baseUrl: 'http://x', scheduler: clock.scheduler, watchdogMs: 40_000,
    openStream: harness.openStream,
  });
  assert.equal(harness.opens(), 0);

  const u1 = subscribe(s, 'ses_a', []);
  await drain();
  assert.equal(harness.opens(), 1);

  const u2 = subscribe(s, 'ses_b', []);
  assert.equal(harness.opens(), 1); // second subscriber reuses the socket

  u1(); u2();
  // Closing the last subscriber tears the connection down; a new one opens fresh.
  const u3 = subscribe(s, 'ses_c', []);
  await drain();
  assert.equal(harness.opens(), 2);
  u3();
});

test('a dropped connection reconnects with backoff and reopens the stream', async () => {
  const clock = makeClock();
  let opens = 0;
  const s = new OpencodeEventStream({
    baseUrl: 'http://x', scheduler: clock.scheduler,
    watchdogMs: 40_000, recheckMs: 1_000, reconnectBaseMs: 10, reconnectCapMs: 640,
    openStream: async () => {
      opens += 1;
      // Every stream closes immediately, simulating an EOF/disconnect.
      return new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
    },
  });
  const unsubscribe = subscribe(s, 'ses_a', []);
  await drain(); await drain();
  assert.equal(opens, 1);

  // First reconnect fires on the base delay, then backs off.
  clock.advance(0);
  await drain(); await drain();
  assert.equal(opens, 2);

  clock.advance(5);
  assert.equal(opens, 2); // not yet past the doubled delay
  clock.advance(6);
  await drain(); await drain();
  assert.equal(opens, 3);

  unsubscribe();
});

test('a wedged stream — open but silent — is torn down by the heartbeat watchdog', async () => {
  const clock = makeClock();
  let opens = 0;
  const s = new OpencodeEventStream({
    baseUrl: 'http://x', scheduler: clock.scheduler,
    watchdogMs: 40, recheckMs: 5, reconnectBaseMs: 10, reconnectCapMs: 640,
    openStream: async (_url, signal) => {
      opens += 1;
      // Opens, but never yields a byte — a live socket delivering nothing.
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
      signal.addEventListener('abort', () => controller.close());
      return stream;
    },
  });
  const unsubscribe = subscribe(s, 'ses_a', []);
  await drain(); await drain();
  const before = opens;

  // Far past the 40 ms silence window: the watchdog must reconnect regardless
  // of the socket being open, because a silent-open stream is exactly the
  // "wedged" failure mode polling exists to cover.
  clock.advance(10_000);
  await drain(); await drain();
  clock.advance(0);        // fire the reconnect its EOF just scheduled
  await drain(); await drain();
  assert.ok(opens > before, 'a silent-open stream must reconnect');
  unsubscribe();
});

test('a healthy stream that keeps beating stays connected', async () => {
  // Run on real timers with tiny windows: heartbeats every 12 ms must keep the
  // connection from being recreated while its 120 ms silence window never hits.
  let opens = 0;
  let beats: ReturnType<typeof setInterval> | undefined;
  const s = new OpencodeEventStream({
    baseUrl: 'http://x', watchdogMs: 120, recheckMs: 5, reconnectBaseMs: 5,
    openStream: async () => {
      opens += 1;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
      beats = setInterval(() => controller.enqueue(utf8(': heartbeat\n\n')), 15);
      return stream;
    },
  });
  const unsubscribe = subscribe(s, 'ses_a', []);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(opens, 1, 'beats arriving on schedule suppress reconnect');
  unsubscribe();
  if (beats) clearInterval(beats);
});
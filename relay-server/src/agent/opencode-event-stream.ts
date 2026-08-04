/**
 * One connection to opencode's global event stream.
 *
 * `opencode serve` exposes `GET /api/event`, a live-only SSE feed carrying
 * every session's events, tagged with `durable.aggregateID` and
 * `data.sessionID`. It replays nothing and beats a `: heartbeat` comment on a
 * measured 15 s cadence. This class owns exactly that socket and nothing else:
 * no transcript reads, no message reconstruction — the adapter keeps those.
 *
 * The interface is a subscriber registry rather than a stream object. The
 * connection opens on the first subscriber and closes on the last, so a daemon
 * with no phone attached holds no socket. Incoming frames are routed to
 * subscribers by session id; events for unwatched sessions are dropped at the
 * lookup. An event that carries neither `durable.aggregateID` nor
 * `data.sessionID` falls back to waking every subscriber rather than being
 * dropped.
 *
 * Because the feed is live-only, a reconnect leaves a gap. The reconnect is
 * surfaced through `onConnectionChange`, and the adapter closes that gap with
 * one transcript fetch — the `after` cursor on the per-session route is
 * deliberately unused.
 */
export interface OpencodeEvent {
  type: string;
  durable?: { aggregateID?: string };
  data?: { sessionID?: string; assistantMessageID?: string; delta?: string };
}

export type Unsubscribe = () => void;

/** The session id an event belongs to, or undefined for a broadcast-worthy event. */
export function opencodeEventSessionId(event: OpencodeEvent): string | undefined {
  return event.durable?.aggregateID ?? event.data?.sessionID;
}

/** Injectable scheduling so tests can drive the watchdog deterministically. */
export interface EventStreamScheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

/** The default scheduler runs on real time. */
const defaultScheduler: EventStreamScheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

export interface OpencodeEventStreamOptions {
  baseUrl: string;
  scheduler?: EventStreamScheduler;
  /**
   * Maximum silence (no event, no heartbeat) before the stream is declared
   * wedged and torn down. 40 s = two missed 15 s beats plus jitter.
   */
  watchdogMs?: number;
  /** How often the watchdog re-checks how long it has been silent. */
  recheckMs?: number;
  /** First reconnect delay after a drop. */
  reconnectBaseMs?: number;
  /** Longest reconnect delay. */
  reconnectCapMs?: number;
  /** Injectable source of the streamed bytes; default uses `fetch`. */
  openStream?: (baseUrl: string, signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>;
}

interface Subscriber {
  sessionId: string;
  onEvent: (event: OpencodeEvent) => void;
}

export class OpencodeEventStream {
  private readonly scheduler: EventStreamScheduler;
  private readonly watchdogMs: number;
  private readonly recheckMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectCapMs: number;
  private readonly openStream: (baseUrl: string, signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>;

  private readonly subscribers = new Map<string, Set<(event: OpencodeEvent) => void>>();
  private readonly connectionListeners = new Set<(connected: boolean) => void>();

  private controller: AbortController | null = null;
  private reading = false;
  private connected = false;
  private disposed = false;
  private lastBeat = 0;
  private reconnectDelay = 0;
  private reconnectTimer: unknown = null;
  private watchdogTimer: unknown = null;

  constructor(private readonly options: OpencodeEventStreamOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.watchdogMs = options.watchdogMs ?? 40_000;
    this.recheckMs = options.recheckMs ?? 2_000;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 1_000;
    this.reconnectCapMs = options.reconnectCapMs ?? 60_000;
    this.openStream = options.openStream ?? defaultOpenStream;
  }

  /** True while the SSE socket is open and beating. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Notified on every transition into or out of a live connection. */
  onConnectionChange(cb: (connected: boolean) => void): Unsubscribe {
    this.connectionListeners.add(cb);
    return () => this.connectionListeners.delete(cb);
  }

  /**
   * Deliver this session's events. The connection opens on the first
   * subscriber and closes on the last.
   */
  subscribe(sessionId: string, onEvent: (event: OpencodeEvent) => void): Unsubscribe {
    let set = this.subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(sessionId, set);
    }
    set.add(onEvent);
    if (this.subscribers.size === 1) this.start();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      set?.delete(onEvent);
      if (set && set.size === 0) this.subscribers.delete(sessionId);
      if (this.subscribers.size === 0) this.stop();
    };
  }

  /** Number of attached sessions. */
  subscriberCount(): number {
    return this.subscribers.size;
  }

  // MARK: - connection lifecycle

  private start(): void {
    this.disposed = false;
    this.reconnectDelay = 0;
    this.connect();
  }

  private stop(): void {
    this.disposed = true;
    this.scheduler.clearTimeout(this.reconnectTimer);
    this.scheduler.clearTimeout(this.watchdogTimer);
    this.controller?.abort();
    this.controller = null;
    this.reading = false;
    this.connected = false;
  }

  private async connect(): Promise<void> {
    const signal = new AbortController();
    this.controller = signal;
    this.scheduler.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await this.openStream(this.options.baseUrl, signal.signal);
    } catch {
      if (this.subscribers.size === 0) return;
      this.scheduleReconnect();
      return;
    }
    if (signal.signal.aborted || this.subscribers.size === 0) return;

    this.reading = true;
    this.touch();
    this.setConnected(true);
    const reader = stream.getReader();
    const parser = new SseParser();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal.signal.aborted) return;
        for (const frame of parser.push(value)) this.deliver(frame);
      }
    } catch {
      // Stream error — same recovery as an EOF.
    } finally {
      this.reading = false;
      this.setConnected(false);
      if (!this.disposed && this.subscribers.size > 0) this.scheduleReconnect();
    }
  }

  /** A byte (event or heartbeat) arrived: refresh the silence timestamp. */
  private touch(): void {
    this.lastBeat = this.scheduler.now();
    this.armWatchdog();
  }

  /**
   * Schedule the next silence check. A stream is declared wedged only when it
   * is open but has produced nothing for the whole window — an idle one still
   * beats every 15 s, so silence is a real signal rather than an ambiguous one.
   */
  private armWatchdog(): void {
    this.scheduler.clearTimeout(this.watchdogTimer);
    this.watchdogTimer = this.scheduler.setTimeout(() => {
      if (!this.reading) return;
      if (this.scheduler.now() - this.lastBeat > this.watchdogMs) {
        this.controller?.abort();
      } else {
        this.armWatchdog();
      }
    }, this.recheckMs);
  }

  private scheduleReconnect(): void {
    if (this.subscribers.size === 0 || this.reconnectTimer !== null) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(Math.max(this.reconnectDelay * 2, this.reconnectBaseMs), this.reconnectCapMs);
    this.reconnectTimer = this.scheduler.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.subscribers.size === 0) return;
      this.connect();
    }, delay);
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    for (const cb of this.connectionListeners) cb(connected);
  }

  private deliver(frame: SseFrame): void {
    this.touch();
    if (frame.beat) return;
    if (!frame.data) return;
    let event: OpencodeEvent;
    try {
      event = JSON.parse(frame.data) as OpencodeEvent;
    } catch {
      // A malformed SSE frame is not ours to repair; it must never take the
      // whole stream down with it.
      return;
    }
    if (typeof event.type !== 'string') return;
    if (frame.event && !event.type) event.type = frame.event;

    const sessionId = opencodeEventSessionId(event);
    if (sessionId) {
      const set = this.subscribers.get(sessionId);
      if (set) for (const cb of set) cb(event);
      return;
    }
    // No session id anywhere: wake every subscriber rather than dropping.
    for (const set of this.subscribers.values()) {
      for (const cb of set) cb(event);
    }
  }
}

async function defaultOpenStream(baseUrl: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(`${baseUrl}/api/event`, { signal });
  if (!res.ok || !res.body) throw new Error(`opencode /api/event answered ${res.status}`);
  return res.body;
}

interface SseFrame {
  event?: string;
  data?: string;
  beat: boolean;
}

/**
 * Incremental SSE parser. Frames are separated by a blank line; a frame's
 * fields are `name: value` lines where a leading `:` marks a comment
 * (heartbeat). `data` lines accumulate and join with newlines.
 */
class SseParser {
  private buffer = '';

  push(chunk: Uint8Array): SseFrame[] {
    this.buffer += new TextDecoder().decode(chunk);
    const frames: SseFrame[] = [];
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match || match.index < 0) break;
      const raw = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      frames.push(this.parse(raw));
    }
    return frames;
  }

  private parse(raw: string): SseFrame {
    let event: string | undefined;
    const data: string[] = [];
    let beat = false;
    for (const line of raw.split(/\r?\n/)) {
      if (line === '') continue;
      if (line.startsWith(':')) {
        beat = true;
        continue;
      }
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      // `data:` with no space keeps the leading space per spec; every real
      // frame here is `data: {...}`, so dropping it is exact enough.
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    return { event, data: data.length > 0 ? data.join('\n') : undefined, beat };
  }
}

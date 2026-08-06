import type { AgentAdapter, AgentEvent, HistoryPage, PermissionBehavior, Unsubscribe } from './adapter.js';
import type { AgentMessage, AgentSessionSummary, AgentQuestionInfo, MessageBlock } from './types.js';
import type { OpencodeClient } from './opencode-client.js';
import type { OpencodeEventStream } from './opencode-event-stream.js';
import { HerdrAgentCli } from './herdr-agent-cli.js';
import { SessionLiveness } from './session-liveness.js';
import { deskRegistryFor, isInjectable, type DeskRegistry, type DeskTarget } from './desk-target.js';
import { activeMultiplexer } from '../multiplexer.js';
import { injectPrompt, waitUntilSettled } from './desk-inject.js';

/** Thrown by capabilities not yet built, so a caller never mistakes a no-op for success. */
export class AgentUnsupportedError extends Error {
  constructor(what: string) {
    super(`${what} is not supported yet`);
    this.name = 'AgentUnsupportedError';
  }
}

const POLL_MS = 1000;
/** Safety poll only while the stream is healthy, catching a renamed prefix. */
const SAFETY_POLL_MS = 15_000;
/** Coalesces a burst of structural events into one transcript read. */
const STRUCTURAL_DEBOUNCE_MS = 150;
/** Coalesces a burst of text deltas into one or two relay frames. */
const DELTA_FLUSH_MS = 100;
/** Bounded fallback when a transcript tool-use predates the question API. */
const QUESTION_RETRY_ATTEMPTS = 3;
const QUESTION_RETRY_DELAY_MS = 500;

export interface OpencodeAdapterDeps {
  desk?: DeskRegistry;
  liveness?: SessionLiveness;
  cli?: HerdrAgentCli;
  inject?: (paneId: string, text: string, mux: 'herdr' | 'tmux') => Promise<void>;
  watchStatus?: (target: DeskTarget) => Promise<void>;
}

export class OpencodeAdapter implements AgentAdapter {
  readonly kind = 'opencode' as const;

  private readonly desk: DeskRegistry;
  private readonly liveness: SessionLiveness;
  private readonly inject: (paneId: string, text: string, mux: 'herdr' | 'tmux') => Promise<void>;
  private readonly watchStatus: (target: DeskTarget) => Promise<void>;
  private eventSink: ((event: AgentEvent) => void) | null = null;

  constructor(
    private readonly client: OpencodeClient,
    private readonly eventStream?: OpencodeEventStream,
    deps: OpencodeAdapterDeps = {},
  ) {
    const cli = deps.cli ?? new HerdrAgentCli();
    this.desk = deps.desk ?? deskRegistryFor(activeMultiplexer());
    this.liveness = deps.liveness ?? new SessionLiveness();
    this.inject = deps.inject ?? ((paneId, text, mux) => injectPrompt(cli, paneId, text, mux));
    this.watchStatus = deps.watchStatus ?? ((target) => waitUntilSettled(cli, target));
  }

  /** Where desk-send turn ends go; the transcript tail cannot announce them. */
  setEventSink(sink: (event: AgentEvent) => void): void {
    this.eventSink = sink;
  }

  /** async so a client that throws synchronously still yields a rejected promise. */
  async list(): Promise<AgentSessionSummary[]> {
    return this.client.listSessions();
  }

  async history(sessionId: string, beforeSeq: number | null, limit: number): Promise<HistoryPage> {
    const all = await this.client.listMessages(sessionId);
    const end = beforeSeq === null ? all.length : all.findIndex((m) => m.seq === beforeSeq);
    const stop = end < 0 ? all.length : end;
    const start = Math.max(0, stop - limit);
    return { messages: all.slice(start, stop), hasMore: start > 0 };
  }

  /**
   * Subscribes to a session. What used to be a 1000 ms transcript poll is now
   * driven by opencode's `/api/event` stream: `session.next.*` structural
   * events schedule a debounced ~150 ms `listTranscript()` read, and
   * `session.next.text.delta` events are coalesced and forwarded as `delta`
   * events without touching the transcript at all. The transcript is still the
   * truth — structural events only mean "something changed, go look", and the
   * authoritative message always wins over a preview.
   *
   * Two guards keep the signal from becoming an outage:
   * - a **fallback poll (1 s)** runs only while the stream is unavailable, and
   * - a **safety poll (15 s)** runs only while the stream is healthy, catching
   *   an opencode that is streaming fine but has stopped delivering
   *   `session.next.*` events (e.g. a release that renamed the prefix).
   *
   * Messages are tracked by identity and content, not by `seq`. An assistant
   * message is created the moment the turn starts and then *grows* — opencode
   * appends parts to it for as long as the model is producing. Re-emitting on a
   * content change is what makes the reply arrive, and it is unchanged here.
   */
  async subscribe(sessionId: string, sinceSeq: number, onEvent: (event: AgentEvent) => void): Promise<Unsubscribe> {
    let stopped = false;
    /** message id → fingerprint of what we last sent for it. */
    const sent = new Map<string, string>();
    const seenQuestionToolUseIds = new Set<string>();
    let wasRunning: boolean | null = null;

    const intervals: ReturnType<typeof setInterval>[] = [];
    let fetchTimer: ReturnType<typeof setTimeout> | null = null;
    let deltaTimer: ReturnType<typeof setTimeout> | null = null;

    const transcript = async () => {
      if (stopped) return;
      try {
        const { messages, running } = await this.client.listTranscript(sessionId);
        if (stopped) return;

        for (const message of messages) {
          if (message.seq <= sinceSeq && !sent.has(message.id)) continue;
          // The pending flag is part of identity, not just content: a queued user
          // message and its eventual reply are the same id, and only the flag
          // distinguishes them. Without it the queued state, once emitted, would
          // never be re-rendered as answered.
          const fingerprint = JSON.stringify({ blocks: message.blocks, pending: message.pending ?? false });
          if (sent.get(message.id) === fingerprint) continue;
          sent.set(message.id, fingerprint);
          onEvent({ kind: 'message', sessionId, seq: message.seq, message });
        }

        // The phone's "Working…" indicator is driven entirely by these; the first
        // read only reports a turn already in progress, so it cannot race the
        // send and clear a spinner the user just triggered.
        const settling = wasRunning === null && !running;
        if (running !== wasRunning && !settling) {
          onEvent({
            kind: 'status', sessionId, seq: -1,
            status: running ? 'turn_start' : 'turn_end',
          });
        }
        wasRunning = running;

        // Detect opencode `question` tool calls and emit question events.
        await detectQuestions(this.client, seenQuestionToolUseIds, messages, sessionId, onEvent);
      } catch (err) {
        // A read failure (SSE or HTTP) while a turn is tracked must not leave
        // the phone spinning "Working…" forever: emit one error and forget the
        // running flag. The next successful read re-derives everything, so a
        // silent idle failure stays silent and recovery is automatic.
        if (stopped) return;
        if (wasRunning) {
          wasRunning = false;
          onEvent({ kind: 'status', sessionId, seq: -1, status: 'error', detail: `transcript read failed: ${(err as Error).message}` });
        }
      }
    };

    // --- structural events → debounced transcript read ----------------------
    const scheduleFetch = () => {
      if (fetchTimer) clearTimeout(fetchTimer);
      fetchTimer = setTimeout(() => {
        fetchTimer = null;
        void transcript();
      }, STRUCTURAL_DEBOUNCE_MS);
    };

    // --- text deltas → coalesced preview frame ------------------------------
    // opencode emits ~16 deltas for a short reply. They must not be forwarded
    // one-for-one; coalescing here means the ordered, reliable relay carries a
    // couple of frames rather than sixteen, and the transcript reconciles at
    // end-of-text.
    const buffers = new Map<string, string>();
    const scheduleDeltaFlush = () => {
      if (deltaTimer) return;
      deltaTimer = setTimeout(() => {
        deltaTimer = null;
        if (stopped) return;
        for (const [messageId, text] of buffers) {
          if (text) onEvent({ kind: 'delta', sessionId, messageId, text });
        }
        buffers.clear();
      }, DELTA_FLUSH_MS);
    };

    const onOpencodeEvent = (event: { type: string; data?: { assistantMessageID?: string; delta?: string } }) => {
      if (stopped) return;
      if (event.type === 'session.next.text.delta') {
        const messageId = event.data?.assistantMessageID;
        const delta = event.data?.delta;
        if (typeof messageId === 'string' && typeof delta === 'string') {
          buffers.set(messageId, (buffers.get(messageId) ?? '') + delta);
          scheduleDeltaFlush();
        }
        return;
      }
      // Anything else is structural: schedule an authoritative reconcile.
      scheduleFetch();
    };

    const streamUnsubscribe = this.eventStream?.subscribe(sessionId, onOpencodeEvent);
    const connectionUnsubscribe = this.eventStream?.onConnectionChange((connected) => {
      if (stopped || !connected) return;
      // A reconnect left a live-only gap; drop any half-streamed previews and
      // let the authoritative transcript reconcile everything.
      buffers.clear();
      void transcript();
    });

    // Fallback poll: only while the stream is unavailable. With no stream at
    // all (an opencode without /api/event), `isConnected()` is undefined and
    // this degrades to exactly the old 1 s poll.
    intervals.push(setInterval(() => {
      if (!this.eventStream?.isConnected()) void transcript();
    }, POLL_MS));

    // Safety poll: only while the stream is healthy, catching a stream that
    // keeps beating but no longer delivers our `session.next.*` events.
    intervals.push(setInterval(() => {
      if (this.eventStream?.isConnected()) void transcript();
    }, SAFETY_POLL_MS));

    void transcript();

    return () => {
      stopped = true;
      for (const node of intervals) clearInterval(node);
      if (fetchTimer) clearTimeout(fetchTimer);
      if (deltaTimer) clearTimeout(deltaTimer);
      streamUnsubscribe?.();
      connectionUnsubscribe?.();
    };
  }

  /**
   * Deliver a message to wherever the user will actually see it.
   *
   * The HTTP API is headless: a prompt posted to termcastd's `opencode serve`
   * is promoted and executed by that process, and an opencode TUI attached to
   * the same session never renders it (measured — see the design doc). So a
   * reachable session is driven through its pane, and a live-but-unreachable
   * one is refused rather than answered behind the TUI's back.
   */
  async send(sessionId: string, text: string): Promise<void> {
    const target = await this.desk.lookup('opencode', sessionId);
    if (target) {
      if (!isInjectable(target.status)) {
        throw new Error('That session is busy at the desk — it is still working or waiting on you.');
      }
      await this.inject(target.paneId, text, target.mux);
      void this.watchUntilSettled(sessionId, target);
      return;
    }

    const summaries = await this.list().catch((): AgentSessionSummary[] => []);
    const projectPath = summaries.find((s) => s.id === sessionId)?.projectPath ?? '';
    if (await this.liveness.isAlive('opencode', sessionId, projectPath)) {
      throw new Error(
        'That session is open in a terminal on your Mac that cannot be mirrored. ' +
        'Reopen it inside your multiplexer to chat from here.',
      );
    }

    return this.client.sendMessage(sessionId, text);
  }

  private async watchUntilSettled(sessionId: string, target: DeskTarget): Promise<void> {
    try {
      await this.watchStatus(target);
    } catch {
      // Multiplexer gone — end the turn rather than pin the phone on Working.
    }
    this.eventSink?.({ kind: 'status', sessionId, seq: -1, status: 'turn_end' });
  }

  interrupt(sessionId: string): Promise<void> {
    return this.client.interrupt(sessionId);
  }

  async respondPermission(_requestId: string, _behavior: PermissionBehavior): Promise<void> {
    throw new AgentUnsupportedError('opencode permissions');
  }

  async respondQuestion(requestId: string, answers?: string[], rejected?: boolean): Promise<void> {
    if (rejected) {
      await this.client.rejectQuestion(requestId);
    } else {
      await this.client.answerQuestion(requestId, answers ?? []);
    }
  }
}

const seenQuestionToolUseIds = new Set<string>();

/**
 * Convert an unstructured `question` tool-use block into an `AgentQuestionInfo`,
 * or `null` when the block carries nothing usable. The transcript can race the
 * question API, so the block is only a fallback.
 */
function parseQuestionToolUse(
  block: Extract<MessageBlock, { kind: 'toolUse' }>,
  sessionId: string,
): AgentQuestionInfo | null {
  const toolUseId = block.toolUseId;
  if (!toolUseId) return null;

  let prompt: string;
  let options: { label: string; description: string | undefined }[] = [];
  try {
    const input = JSON.parse(block.input) as Record<string, unknown>;
    const rawOptions = Array.isArray(input.options) ? input.options : [];
    options = rawOptions.map((o: unknown) => {
      const opt = o as Record<string, unknown>;
      return {
        label: typeof opt.label === 'string' ? opt.label : String(opt),
        description: typeof opt.description === 'string' ? opt.description : undefined,
      };
    });
    prompt = typeof input.prompt === 'string' ? input.prompt : block.summary;
  } catch {
    prompt = block.summary;
  }
  if (!prompt.trim() && options.length === 0) return null;

  return {
    requestId: toolUseId, sessionId, agent: 'opencode',
    prompt, kind: options.length > 0 ? 'select' : 'freeform', options,
    createdAt: new Date().toISOString(),
  };
}

async function detectQuestions(
  client: OpencodeClient,
  seen: Set<string>,
  messages: AgentMessage[],
  sessionId: string,
  onEvent: (event: AgentEvent) => void,
): Promise<void> {
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.blocks) {
      if (block.kind !== 'toolUse' || block.name !== 'question') continue;
      const toolUseId = block.toolUseId;
      if (!toolUseId || seen.has(toolUseId)) continue;
      seen.add(toolUseId);

      // The question API is authoritative; the block is a fallback. When neither
      // resolves, retry the API for a bounded window — a block can appear in the
      // transcript a moment before the question is queryable.
      let request: AgentQuestionInfo | null = null;
      for (let attempt = 0; attempt < QUESTION_RETRY_ATTEMPTS && !request; attempt += 1) {
        const entries = await client.listQuestions(sessionId).catch(() => []);
        const entry = entries.find((e) => e.requestId === toolUseId);
        if (entry) {
          request = entry;
        } else {
          request = parseQuestionToolUse(block, sessionId);
          if (!request && attempt + 1 < QUESTION_RETRY_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, QUESTION_RETRY_DELAY_MS));
          }
        }
      }
      if (!request) continue;

      onEvent({
        kind: 'question', sessionId, seq: message.seq,
        request,
      });
    }
  }
}
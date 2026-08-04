import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentMessage, AgentSessionSummary, AgentQuestionOption, MessageBlock, MessageRole } from './types.js';

const MAX_BLOCK_CHARS = 2048;
const REQUEST_TIMEOUT_MS = 5000;
/**
 * Messages requested from the v2 route in one call.
 *
 * 200 is the route's hard maximum — it rejects anything larger with a 400
 * ("Expected a value less than or equal to 200"), which this client turns into
 * an empty result, silently dropping every live message. Not a value to raise
 * without checking the server.
 */
const V2_MESSAGE_LIMIT = 200;

/** Default location of opencode's SQLite store, mirroring the desktop metrics read. */
export function defaultOpencodeDbPath(): string {
  return join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

interface RawSession {
  id?: unknown; title?: unknown; model?: unknown;
  time?: { created?: unknown; updated?: unknown };
  location?: { directory?: unknown };
}

/**
 * Typed client for a running `opencode serve`.
 *
 * opencode keeps a session's transcript in **two** places, and this reads both.
 * Before the `session_message` migration it wrote messages to the `message` and
 * `part` SQLite tables; those rows are frozen history now, reachable only over
 * SQLite or the unversioned `/session/...` routes. Everything since — every
 * live turn — goes to the `session_message` store behind the `/api` (v2)
 * routes, and the two never see each other: `/api/session/{id}/message` answers
 * `{"data":[]}` for a pre-migration session, and the legacy tables never gain a
 * row for a new one.
 *
 * Reading only the SQLite half is what made a session look frozen: the history
 * rendered, then nothing the agent produced afterwards ever appeared.
 *
 * Reads degrade to an empty result instead of throwing — opencode may not be
 * installed, and an absent agent must contribute nothing rather than breaking
 * the whole session list. `sendMessage` is the deliberate exception: a prompt
 * that was not delivered has to surface, or the phone waits on a reply that is
 * never coming.
 */
export class OpencodeClient {
  /** sessionId → project directory, learned from `listSessions`. */
  private readonly directories = new Map<string, string>();

  constructor(
    private readonly baseUrl: string,
    private readonly dbPath?: string,
  ) {}

  /**
   * The project directory a session belongs to, for the `x-opencode-directory`
   * header. Falls back to the store because `attach` can reach this client
   * before any `listSessions` has populated the cache.
   */
  private directoryFor(sessionId: string): string | undefined {
    const cached = this.directories.get(sessionId);
    if (cached) return cached;
    if (!this.dbPath || !existsSync(this.dbPath)) return undefined;

    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(this.dbPath, { readOnly: true });
      const row = db.prepare('SELECT directory FROM session WHERE id = ?').get(sessionId) as
        | { directory?: string }
        | undefined;
      const directory = row?.directory;
      if (directory) this.directories.set(sessionId, directory);
      return directory ?? undefined;
    } catch {
      return undefined;
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Probes `/api/session` rather than a dedicated health route: session listing
   * is a route the server is known to expose, so a 200 here proves both that
   * something is listening and that it speaks the API we need.
   */
  async health(): Promise<boolean> {
    return (await this.get('/api/session')) !== null;
  }

  async listSessions(): Promise<AgentSessionSummary[]> {
    // `roots=true` is opencode's own "user-initiated sessions only" filter — it
    // drops the subagent children. Versions before it silently ignore the
    // param and return everything, which is why the SQLite filter below still
    // runs rather than trusting the server.
    const body = await this.get('/api/session?roots=true');
    const rows = asArray((body as { data?: unknown } | null)?.data);
    const summaries = rows.map((row) => this.toSummary(row as RawSession));
    for (const summary of summaries) {
      if (summary.projectPath) this.directories.set(summary.id, summary.projectPath);
    }
    return (await this.filterUserInitiated(summaries)) ?? summaries;
  }

  /**
   * Only user-initiated sessions, matching the desktop opencode session list:
   * drops observer/subagent sessions (children of another session, e.g. an
   * `@explore` subagent) and the empty "New session - <ts>" placeholders the
   * serve auto-creates. Returns null when the store is unusable so the caller
   * keeps the unfiltered HTTP listing.
   */
  private async filterUserInitiated(sessions: AgentSessionSummary[]): Promise<AgentSessionSummary[] | null> {
    if (!this.dbPath || !existsSync(this.dbPath) || sessions.length === 0) return null;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(this.dbPath, { readOnly: true });
      const hidden = new Set<string>();
      for (const row of db.prepare(
        "SELECT id FROM session WHERE parent_id IS NOT NULL AND parent_id != ''",
      ).all() as { id: string }[]) {
        hidden.add(row.id);
      }
      // Both stores. Reading only the legacy `message` table would treat every
      // session created after the session_message migration as empty and hide
      // it, so the list would freeze at the upgrade and never show a new
      // conversation again.
      const hasMessages = new Set<string>();
      for (const table of ['message', 'session_message']) {
        try {
          for (const row of db.prepare(
            `SELECT DISTINCT session_id AS id FROM ${table}`,
          ).all() as { id: string }[]) {
            hasMessages.add(row.id);
          }
        } catch {
          // The table belongs to the other side of the migration; whichever one
          // this opencode has is enough.
        }
      }
      const kept = sessions.filter((s) => !hidden.has(s.id) && hasMessages.has(s.id));
      return kept.length > 0 ? kept : null;
    } catch {
      return null;
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
    }
  }

  /**
   * A session's transcript, oldest first.
   *
   * Assembled from both of opencode's stores. Everything written before the
   * `session_message` migration lives in the legacy `message`/`part` tables and
   * is only reachable over SQLite (the v2 route answers `{"data":[]}` for it);
   * every turn since — including anything sent from the phone — lives in the v2
   * store and is invisible to the legacy tables. Reading one alone silently
   * truncates the conversation: for a pre-upgrade session that meant the
   * transcript froze at the upgrade and no new reply ever appeared.
   *
   * The legacy half is strictly older, so concatenating in that order is
   * chronological. `seq` is assigned over the joined list so it stays dense and
   * ordered regardless of which half a message came from.
   */
  async listMessages(sessionId: string): Promise<AgentMessage[]> {
    return (await this.listTranscript(sessionId)).messages;
  }

  /**
   * The transcript plus whether a turn is still running, from one read.
   *
   * The poller needs both on every tick and they come from the same rows, so
   * fetching them together avoids doubling the request rate against opencode.
   */
  async listTranscript(sessionId: string): Promise<{ messages: AgentMessage[]; running: boolean }> {
    const [legacy, live] = await Promise.all([
      this.listMessagesFromDb(sessionId),
      this.listMessagesV2(sessionId),
    ]);
    // A turn is answered only by the v2 store, which is the only live one. A
    // session whose messages exist solely in the legacy tables is by definition
    // not running: nothing writes there (and nothing there is pending).
    const answered = pendingFlags(live.states);
    const legacyCount = legacy?.length ?? 0;
    const joined = [...(legacy ?? []), ...live.messages];
    return {
      messages: joined.map((message, seq) => ({
        ...message,
        seq,
        // `pending` is a property of the live (v2) tail; every legacy row is
        // frozen, answered history. A user message is unanswered exactly when
        // no completed assistant message follows it, which `pendingFlags`
        // already computed for that same tail.
        pending: seq < legacyCount ? false : (answered[seq - legacyCount] && message.role === 'user'),
      })),
      running: isTurnRunning(live.states),
    };
  }

  /**
   * The v2 store, read over HTTP. Returns empty both when the route is absent
   * (an older opencode) and when the session has no v2 messages yet, because
   * the caller treats those identically: nothing to add to the legacy half.
   */
  private async listMessagesV2(sessionId: string): Promise<{ messages: AgentMessage[]; states: TurnState[] }> {
    // `order=asc` asks for oldest-first; builds that predate the param ignore
    // it and answer newest-first, which the sort below then corrects.
    const body = await this.get(
      `/api/session/${encodeURIComponent(sessionId)}/message?limit=${V2_MESSAGE_LIMIT}&order=asc`,
      sessionId,
    );
    const rows = asArray((body as { data?: unknown } | null)?.data) as Record<string, unknown>[];
    const parsed = rows
      .map((row, seq) => ({ message: toMessageV2(row, seq), state: turnStateOf(row) }))
      // A turn-boundary row (opencode's `system` bookkeeping message) carries
      // no renderable block; it still counts toward turn state, which is why
      // the state is captured before the filter.
      .filter((entry) => entry.message.blocks.length > 0 || entry.state.role === 'assistant');

    // The v2 route answers newest-first while the legacy envelope came back
    // oldest-first, so the order is sorted rather than assumed. Only when every
    // message is timestamped — otherwise the received order is all we have and
    // reordering on a partial key would scramble it.
    if (parsed.length > 1 && parsed.every((e) => e.message.timestamp !== null)) {
      parsed.sort((a, b) => (a.message.timestamp ?? '').localeCompare(b.message.timestamp ?? ''));
    }

    return {
      messages: parsed.filter((e) => e.message.blocks.length > 0).map((e) => e.message),
      states: parsed.map((e) => e.state),
    };
  }

  /**
   * Rebuilds a session's transcript from opencode's SQLite store. Returns null
   * when the store is unusable so the caller can fall back to the HTTP route.
   */
  private async listMessagesFromDb(sessionId: string): Promise<AgentMessage[] | null> {
    if (!this.dbPath || !existsSync(this.dbPath)) return null;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(this.dbPath, { readOnly: true });
      const rows = db.prepare(
        'SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created, rowid',
      ).all(sessionId) as { id: string; data: string; time_created: number }[];

      const partsByMessage = new Map<string, Record<string, unknown>[]>();
      const parts = db.prepare(
        'SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created, rowid',
      ).all(sessionId) as { message_id: string; data: string }[];
      for (const part of parts) {
        const list = partsByMessage.get(part.message_id) ?? [];
        list.push(JSON.parse(part.data) as Record<string, unknown>);
        partsByMessage.set(part.message_id, list);
      }

      return rows.map((row, seq) => {
        const data = JSON.parse(row.data) as Record<string, unknown>;
        // The row's own time_created is authoritative: `data.time` is absent on
        // some versions, and the column is what opencode orders by.
        const info = { ...data, id: row.id, time: { created: row.time_created } };
        return toMessageLegacy({ info, parts: partsByMessage.get(row.id) ?? [] }, seq);
      });
    } catch {
      // Corrupt store or a version whose schema differs; fall back to HTTP.
      return null;
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Hand a prompt to opencode and let it run the turn.
   *
   * `POST /api/session/{id}/prompt` is the v2 route and returns as soon as the
   * prompt is admitted, so there is nothing to stream here. The unversioned
   * `/session/{id}/message` is the same operation on older builds.
   *
   * Throws when neither is accepted. That matters: an unmatched opencode route
   * falls through to its web UI and answers **HTTP 200 with index.html**, so
   * "not ok" is never how this fails. The previous version posted to the v2
   * path with the v1 body, got the HTML back, let `res.json()` throw into a
   * catch that returned null, and reported success — the phone showed the
   * user's own bubble and then "Working…" forever for a turn opencode had
   * never been told about.
   */
  async sendMessage(sessionId: string, text: string): Promise<void> {
    const id = encodeURIComponent(sessionId);
    if (await this.post(`/api/session/${id}/prompt`, { prompt: { text } }, sessionId)) return;
    if (await this.post(`/session/${id}/message`, { parts: [{ type: 'text', text }] }, sessionId)) return;
    throw new Error(
      'opencode did not accept the message: neither /api/session/{id}/prompt nor ' +
      '/session/{id}/message responded. Check that `opencode serve` is running and up to date.',
    );
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.post(`/api/session/${encodeURIComponent(sessionId)}/interrupt`, {}, sessionId);
  }

  /** Pending questions from opencode's question API. */
  async listQuestions(sessionId: string): Promise<AgentQuestionOption[]> {
    const body = await this.get(
      `/api/session/${encodeURIComponent(sessionId)}/question`,
      sessionId,
    );
    return asArray((body as { data?: unknown } | null)?.data).map((q) => {
      const r = q as Record<string, unknown>;
      return {
        requestId: str(r.requestId) ?? '',
        sessionId,
        agent: 'opencode' as const,
        prompt: str(r.prompt) ?? '',
        kind: (str(r.kind) === 'freeform' ? 'freeform' : 'select') as 'select' | 'freeform',
        options: asArray(r.options).map((o) => {
          const opt = o as Record<string, unknown>;
          return { label: str(opt.label) ?? '', description: str(opt.description) };
        }),
        createdAt: str(r.createdAt) ?? new Date().toISOString(),
      };
    });
  }

  async answerQuestion(requestId: string, answers: string[]): Promise<void> {
    await this.post(`/api/session/question/${encodeURIComponent(requestId)}/answer`, { answers });
  }

  async rejectQuestion(requestId: string): Promise<void> {
    await this.post(`/api/session/question/${encodeURIComponent(requestId)}/reject`, {});
  }

  /** Append to the TUI input draft without submitting. Best-effort. */
  async appendPrompt(sessionId: string, text: string): Promise<void> {
    await this.post(
      `/api/session/${encodeURIComponent(sessionId)}/prompt/draft`,
      { text, append: true },
      sessionId,
    );
  }

  /** Submit the current TUI input draft. Best-effort. */
  async submitPrompt(sessionId: string): Promise<void> {
    await this.post(
      `/api/session/${encodeURIComponent(sessionId)}/prompt/submit`,
      {},
      sessionId,
    );
  }

  /** Whether the last v2 message is a user turn (the TUI has input). */
  async hasUserMessage(sessionId: string): Promise<boolean> {
    const body = await this.get(
      `/api/session/${encodeURIComponent(sessionId)}/message?limit=1&order=desc`,
      sessionId,
    );
    const rows = asArray((body as { data?: unknown } | null)?.data);
    return rows.length > 0 && (rows[0] as Record<string, unknown>).type === 'user';
  }

  /** The current TUI draft prompt text, if any. Best-effort. */
  async getDraftPrompt(sessionId: string): Promise<string | null> {
    const body = await this.get(
      `/api/session/${encodeURIComponent(sessionId)}/prompt/draft`,
      sessionId,
    );
    if (body && typeof body === 'object' && typeof (body as Record<string, unknown>).text === 'string') {
      return (body as { text: string }).text;
    }
    return null;
  }

  private toSummary(raw: RawSession): AgentSessionSummary {
    const updated = raw.time?.updated;
    const created = raw.time?.created;
    const stamp = typeof updated === 'number' ? updated : typeof created === 'number' ? created : null;
    const model = raw.model;
    return {
      id: str(raw.id) ?? '',
      agent: 'opencode',
      title: str(raw.title) ?? 'Untitled session',
      projectPath: str(raw.location?.directory) ?? '',
      lastActiveAt: stamp === null ? null : new Date(stamp).toISOString(),
      isLive: false,
      messageCount: null,
      model: typeof model === 'object' && model !== null ? str((model as { id?: unknown }).id) : null,
      needsAttention: false,
    };
  }


  private async get(path: string, sessionId?: string): Promise<unknown | null> {
    return this.request(path, { method: 'GET' }, sessionId);
  }

  private async post(path: string, body: unknown, sessionId?: string): Promise<unknown | null> {
    return this.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, sessionId);
  }

  /**
   * `sessionId`, when given, adds the `x-opencode-directory` header naming that
   * session's project.
   *
   * `opencode serve` resolves the project from its own cwd unless a request
   * overrides it, and it only *runs* turns for sessions in that project.
   * termcastd spawns the serve from wherever it happens to be installed, so
   * without this header a prompt for one of the user's own sessions came back
   * 200 with an admitted message id and was then silently never executed.
   */
  private async request(path: string, init: RequestInit, sessionId?: string): Promise<unknown | null> {
    const directory = sessionId ? this.directoryFor(sessionId) : undefined;
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          ...(directory ? { 'x-opencode-directory': directory } : {}),
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      // Not installed, not running, or too slow. Caller degrades.
      return null;
    }
  }
}

/** What `isTurnRunning` needs from one message; not part of the wire type. */
export interface TurnState {
  role: MessageRole;
  finish?: string | null;
  completed?: number | null;
}

/**
 * Which user turns the live tail still owes an answer, newest-to-oldest.
 *
 * Sweeping backward from the newest message, an answered assistant turn
 * (`completed` set and not ending in `tool-calls`, which opencode always
 * follows with another assistant message) clears the debt of every user message
 * older than it. Any user message newer than the newest answered turn is
 * pending — it is queued behind or being worked by the current turn.
 */
export function pendingFlags(states: TurnState[]): boolean[] {
  const out = new Array<boolean>(states.length).fill(false);
  let answeredSeen = false;
  for (let i = states.length - 1; i >= 0; i--) {
    const state = states[i];
    if (state.role === 'assistant' && state.completed != null && state.finish !== 'tool-calls') {
      answeredSeen = true;
    } else if (state.role === 'user') {
      out[i] = !answeredSeen;
    }
  }
  return out;
}

/** Reads the turn-state fields off a raw v2 message row. */
export function turnStateOf(raw: Record<string, unknown>): TurnState {
  const type = raw.type;
  const role: MessageRole = type === 'assistant' ? 'assistant' : type === 'system' ? 'system' : 'user';
  const completed = (raw.time as { completed?: unknown } | undefined)?.completed;
  return {
    role,
    finish: str(raw.finish),
    completed: typeof completed === 'number' ? completed : null,
  };
}

/**
 * The turn state a session is in, read off its transcript.
 *
 * opencode exposes no per-session "busy" flag on the routes we can rely on, but
 * the transcript says it plainly: a turn is running until the newest assistant
 * message has settled. `tool-calls` is explicitly not settled — opencode always
 * follows it with another assistant message carrying the tool's result — so
 * treating it as the end would clear the phone's "Working…" mid-turn.
 */
export function isTurnRunning(messages: TurnState[]): boolean {
  // `system` rows are opencode's own bookkeeping and say nothing about whether
  // the model is working; the newest real turn is what decides.
  const turns = messages.filter((m) => m.role !== 'system');
  const last = turns[turns.length - 1];
  if (!last) return false;
  if (last.role !== 'assistant') return true;
  if (last.completed == null) return true;
  return last.finish === 'tool-calls';
}

/**
 * One message from the v2 (`session_message`) store.
 *
 * The shape differs from the legacy store in every particular: the role is
 * `type`, a user message carries its prompt in `text` rather than in parts, and
 * an assistant message's parts are `content`. Note this does NOT match the
 * server's own OpenAPI document, which still describes the legacy `role`/
 * `parts` layout — it is modelled on what the route actually returns.
 */
export function toMessageV2(raw: Record<string, unknown>, seq: number): AgentMessage {
  // Older builds answer the same route with the legacy `{info, parts}`
  // envelope — and so does the current server's own OpenAPI document, which
  // has not caught up with its runtime. Accept either rather than pinning the
  // client to one opencode version.
  if (raw.info !== undefined || raw.parts !== undefined) return toMessageLegacy(raw, seq);

  const type = raw.type;
  const role: MessageRole = type === 'assistant' ? 'assistant' : type === 'system' ? 'system' : 'user';

  const blocks: MessageBlock[] = [];
  const text = str(raw.text);
  if (text) {
    blocks.push({ kind: 'text', text });
  } else {
    for (const part of asArray(raw.content)) blocks.push(...toBlocksV2(part as Record<string, unknown>));
  }

  const created = (raw.time as { created?: unknown } | undefined)?.created;
  return {
    id: str(raw.id) ?? `seq-${seq}`,
    seq,
    role,
    timestamp: typeof created === 'number' ? new Date(created).toISOString() : null,
    blocks,
  };
}

/** v2 part → blocks. A tool part carries both the call and its result. */
function toBlocksV2(part: Record<string, unknown>): MessageBlock[] {
  if (part.type === 'text' && typeof part.text === 'string' && part.text) {
    return [{ kind: 'text', text: part.text }];
  }
  if (part.type === 'reasoning' && typeof part.text === 'string' && part.text) {
    return [{ kind: 'thinking', text: part.text }];
  }
  if (part.type !== 'tool') return [];

  const state = (part.state ?? {}) as Record<string, unknown>;
  // v2 names the call on the part itself (`id`/`name`); the legacy store used
  // `callID`/`tool`. Both are read so one parser is not version-locked.
  const toolUseId = str(part.id) ?? str(part.callID) ?? '';
  const name = str(part.name) ?? str(part.tool) ?? 'tool';
  const input = clamp(JSON.stringify(state.input ?? {}));
  const blocks: MessageBlock[] = [{
    kind: 'toolUse',
    toolUseId,
    name,
    summary: summarise(name, state.input),
    input: input.text,
    truncated: input.truncated,
  }];

  const output = v2ToolOutput(state);
  if (output !== null) {
    const clamped = clamp(output);
    blocks.push({
      kind: 'toolResult',
      toolUseId,
      ok: state.status !== 'error',
      preview: clamped.text,
      truncated: clamped.truncated,
    });
  }
  return blocks;
}

/** v2 returns tool output as typed content parts; older builds as a string. */
function v2ToolOutput(state: Record<string, unknown>): string | null {
  if (typeof state.output === 'string') return state.output;
  if (!Array.isArray(state.content)) return null;
  const text = state.content
    .map((part) => (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string'
      ? (part as { text: string }).text
      : ''))
    .filter(Boolean)
    .join('\n');
  return text || null;
}

/**
 * One message in the legacy `message`/`part` envelope: `{ info, parts }`, with
 * the role on `info.role`. Used for the SQLite store and for opencode builds
 * whose HTTP route still answers in this shape.
 */
function toMessageLegacy(raw: Record<string, unknown>, seq: number): AgentMessage {
  const info = (raw.info ?? {}) as Record<string, unknown>;
  const role = info.role === 'assistant' ? 'assistant' : info.role === 'system' ? 'system' : 'user';
  const blocks: MessageBlock[] = [];
  for (const part of asArray(raw.parts)) blocks.push(...toBlocks(part as Record<string, unknown>));
  const created = (info.time as { created?: unknown } | undefined)?.created;
  return {
    id: str(info.id) ?? `seq-${seq}`,
    seq,
    role: role as MessageRole,
    // Epoch millis in the store; the wire format is ISO-8601 everywhere else.
    timestamp: typeof created === 'number' ? new Date(created).toISOString() : null,
    blocks,
  };
}

/** A tool part carries both the call and its result; emit both blocks. */
function toBlocks(part: Record<string, unknown>): MessageBlock[] {
  if (part.type === 'text' && typeof part.text === 'string' && part.text) {
    return [{ kind: 'text', text: part.text }];
  }
  if (part.type === 'reasoning' && typeof part.text === 'string' && part.text) {
    return [{ kind: 'thinking', text: part.text }];
  }
  if (part.type !== 'tool') return [];

  const state = (part.state ?? {}) as Record<string, unknown>;
  const toolUseId = str(part.callID) ?? '';
  const name = str(part.tool) ?? 'tool';
  const input = clamp(JSON.stringify(state.input ?? {}));
  const blocks: MessageBlock[] = [{
    kind: 'toolUse',
    toolUseId,
    name,
    summary: summarise(name, state.input),
    input: input.text,
    truncated: input.truncated,
  }];

  if (typeof state.output === 'string') {
    const output = clamp(state.output);
    blocks.push({
      kind: 'toolResult',
      toolUseId,
      ok: state.status !== 'error',
      preview: output.text,
      truncated: output.truncated,
    });
  }
  return blocks;
}

function summarise(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return name;
  const fields = input as Record<string, unknown>;
  const command = str(fields.command);
  if (command) return oneLine(command);
  const path = str(fields.filePath) ?? str(fields.file_path) ?? str(fields.path);
  if (path) return `${name} ${path.split('/').pop()}`;
  return name;
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 79)}…` : collapsed;
}

function clamp(text: string): { text: string; truncated: boolean } {
  return text.length > MAX_BLOCK_CHARS
    ? { text: text.slice(0, MAX_BLOCK_CHARS), truncated: true }
    : { text, truncated: false };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

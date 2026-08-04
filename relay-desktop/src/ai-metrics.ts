// Collects coding-session metrics from the two AI CLI tools this machine runs:
//
//   Claude Code — one JSONL transcript per session under
//     ~/.claude/projects/<encoded-project-dir>/<session-id>.jsonl
//   opencode    — an SQLite database at
//     ~/.local/share/opencode/opencode.db
//
// Everything here is plain Node (no Electron) so it can be unit-tested with
// node:test, mirroring the other src/*.ts modules.

import { createReadStream, readdirSync, statSync, existsSync, type Stats } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { dayKey } from './ai-usage';

/** A session counts as active if touched within this window. */
export const ACTIVE_WINDOW_MS = 15 * 60 * 1000;

/** Per-model roll-up for one session. */
export interface ModelTrace {
  model: string;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface SessionTokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SessionInfo {
  source: 'claude-code' | 'opencode';
  id: string;
  /** Working directory the session ran in, when the tool records it. */
  project: string;
  /** Short human-readable topic. */
  topic: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  /** Model most recently used by the session. */
  currentModel: string;
  agent?: string;
  cost?: number;
  tokens: SessionTokens;
  modelTrace: ModelTrace[];
}

export interface CollectOptions {
  claudeProjectsDir?: string;
  opencodeDbPath?: string;
  /** Inject a clock for deterministic tests. */
  now?: number;
}

/** One billable request, after deduplication. */
export interface UsageRecord {
  source: 'claude-code' | 'opencode';
  sessionId: string;
  model: string;
  /** ms epoch of the request. */
  at: number;
  /** Local-time day key, YYYY-MM-DD, computed at collection time. */
  day: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Cache lifetime implied by the request's ephemeral bucket, ms. 0 if unknown. */
  cacheTtlMs: number;
  stopReason?: string;
  /** The turn was cut short by the user. */
  interrupted?: boolean;
}

const noTokens: SessionTokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };

function defaultClaudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

function defaultOpencodeDbPath(): string {
  return join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

/** Strip ANSI escapes and collapse whitespace so topics read cleanly. */
function tidy(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, ' ').replace(/\s+/g, ' ').trim();
}

export function truncate(text: string, max = 160): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}

/** First human prompt in a Claude Code transcript line, if any. */
function claudeTopic(content: unknown): string | null {
  if (typeof content === 'string') return tidy(content);
  if (Array.isArray(content)) {
    const parts = content
      .filter(b => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
      .map(b => (b as { text: string }).text);
    return tidy(parts.join(' '));
  }
  return null;
}

/** Plain-text extraction from a message content field (string or blocks). */
function claudeContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b && typeof b === 'object' && typeof b.text === 'string')
      .map(b => (b as { text: string }).text)
      .join(' ');
  }
  return '';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Cache lifetime in ms implied by a Claude Code usage cache_creation bucket. */
function cacheTtlMs(usage: Record<string, unknown>): number {
  const creation = usage.cache_creation as Record<string, unknown> | undefined;
  if (creation && num(creation.ephemeral_1h_input_tokens) > 0) return 3_600_000;
  if (creation && num(creation.ephemeral_5m_input_tokens) > 0) return 300_000;
  return 0;
}

// ---- Claude Code -----------------------------------------------------------

interface ClaudeAccumulator {
  topic: string | null;
  project: string | null;
  createdAt: number | null;
  models: Map<string, ModelTrace>;
}

function accModel(acc: ClaudeAccumulator, model: string): ModelTrace {
  let m = acc.models.get(model);
  if (!m) {
    m = { model, messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    acc.models.set(model, m);
  }
  return m;
}

async function parseClaudeSessionFile(file: string, now: number): Promise<{ session: SessionInfo | null; records: UsageRecord[] }> {
  let stat: Stats;
  try {
    stat = statSync(file);
    if (!stat.isFile()) return { session: null, records: [] };
  } catch {
    return { session: null, records: [] };
  }

  const acc: ClaudeAccumulator = { topic: null, project: null, createdAt: null, models: new Map() };
  const records: UsageRecord[] = [];
  const seenIds = new Set<string>();
  const recent: Array<{ assistant: UsageRecord | null }> = [];
  let model: string | null = null;
  const sessionId = basename(file, '.jsonl');

  try {
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.trim() === '') continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (acc.project === null && typeof obj.cwd === 'string' && obj.cwd) acc.project = obj.cwd;
      if (acc.createdAt === null && typeof obj.timestamp === 'string') {
        const t = Date.parse(obj.timestamp);
        if (!Number.isNaN(t)) acc.createdAt = t;
      }

      recent.push({ assistant: null });
      if (recent.length > 4) recent.shift();
      const cur = recent[recent.length - 1];

      const type = obj.type;
      if (type === 'user') {
        const msg = obj.message as { content?: unknown; role?: string } | undefined;
        if (acc.topic === null && msg?.role === 'user') {
          acc.topic = truncate(claudeTopic(msg.content) ?? '', 160) || null;
        }
        if (msg && claudeContentText(msg.content).toLowerCase().includes('request interrupted by user')) {
          for (let i = recent.length - 2, n = 0; i >= 0 && n < 3; i--, n++) {
            const a = recent[i].assistant;
            if (a) {
              a.interrupted = true;
              break;
            }
          }
        }
      } else if (type === 'assistant') {
        const msg = (obj.message ?? obj) as {
          id?: unknown; model?: unknown; stop_reason?: unknown; usage?: unknown;
        };
        const id = typeof msg.id === 'string' ? msg.id : '';
        if (id && seenIds.has(id)) {
          // duplicate content block of an already-counted response
        } else {
          if (id) seenIds.add(id);
          const m = typeof msg.model === 'string' ? msg.model : null;
          if (m) {
            model = m;
            const entry = accModel(acc, m);
            const u = (msg.usage ?? {}) as Record<string, unknown>;
            const input = num(u.input_tokens);
            const output = num(u.output_tokens);
            const cacheRead = num(u.cache_read_input_tokens);
            const cacheWrite = num(u.cache_creation_input_tokens);
            entry.messages += 1;
            entry.inputTokens += input;
            entry.outputTokens += output;
            entry.cacheReadTokens += cacheRead;
            entry.cacheWriteTokens += cacheWrite;

            const at = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
            records.push({
              source: 'claude-code',
              sessionId,
              model: m,
              at: Number.isNaN(at) ? 0 : at,
              day: Number.isNaN(at) ? '' : dayKey(at),
              input,
              output,
              cacheRead,
              cacheWrite,
              cacheTtlMs: cacheTtlMs(u),
              stopReason: typeof msg.stop_reason === 'string' ? msg.stop_reason : undefined,
            });
            cur.assistant = records[records.length - 1];
          }
        }
      } else if (type === 'summary' && acc.topic === null) {
        const s = obj.summary;
        if (typeof s === 'string' && s.trim()) acc.topic = truncate(tidy(s), 160);
      }
    }
  } catch {
    return { session: null, records: [] };
  }

  const trace = [...acc.models.values()].sort((a, b) => b.messages - a.messages);
  const tokens: SessionTokens = { ...noTokens };
  for (const t of trace) {
    tokens.input += t.inputTokens;
    tokens.output += t.outputTokens;
    tokens.cacheRead += t.cacheReadTokens;
    tokens.cacheWrite += t.cacheWriteTokens;
  }

  if (!acc.topic) acc.topic = '(no prompt)';
  const updatedAt = stat.mtimeMs;
  return {
    session: {
      source: 'claude-code',
      id: sessionId,
      project: acc.project ?? '',
      topic: acc.topic,
      active: now - updatedAt <= ACTIVE_WINDOW_MS,
      createdAt: acc.createdAt ?? stat.birthtimeMs,
      updatedAt,
      currentModel: model ?? trace[0]?.model ?? '',
      tokens,
      modelTrace: trace,
    },
    records,
  };
}

async function collectClaudeCodeSessions(opts: CollectOptions, now: number): Promise<{ sessions: SessionInfo[]; records: UsageRecord[] }> {
  const dir = opts.claudeProjectsDir ?? defaultClaudeProjectsDir();
  if (!existsSync(dir)) return { sessions: [], records: [] };

  let projects: string[];
  try {
    projects = readdirSync(dir);
  } catch {
    return { sessions: [], records: [] };
  }

  const sessions: SessionInfo[] = [];
  const records: UsageRecord[] = [];
  for (const name of projects) {
    const projectDir = join(dir, name);
    let stat: Stats;
    try {
      stat = statSync(projectDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || name === 'memory') continue;

    let files: string[];
    try {
      files = readdirSync(projectDir);
    } catch {
      continue;
    }
    const jsonls = files.filter(f => f.endsWith('.jsonl'))
      .map(f => join(projectDir, f))
      .sort((a, b) => statSyncSafe(b).mtimeMs - statSyncSafe(a).mtimeMs);
    for (const file of jsonls) {
      const parsed = await parseClaudeSessionFile(file, now);
      if (parsed.session) sessions.push(parsed.session);
      records.push(...parsed.records);
    }
  }
  return { sessions, records };
}

function statSyncSafe(file: string): Stats {
  try {
    return statSync(file);
  } catch {
    return { mtimeMs: 0 } as Stats;
  }
}

// ---- opencode --------------------------------------------------------------

interface OpencodeRow {
  id: string;
  title: string;
  directory: string | null;
  agent: string | null;
  model: string | null;
  cost: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  time_created: number;
  time_updated: number;
}

function modelLabel(model: { id?: string; providerID?: string } | null | undefined): string {
  if (!model || !model.id) return '';
  return model.providerID && model.providerID !== 'opencode' && model.id.includes('/') === false
    ? `${model.providerID}/${model.id}`
    : model.id;
}

function providerLabel(providerID: string | undefined, modelID: string): string {
  return providerID && providerID !== 'opencode' ? `${providerID}/${modelID}` : modelID;
}

function accModelTrace(trace: Map<string, ModelTrace>, model: string): ModelTrace {
  let entry = trace.get(model);
  if (!entry) {
    entry = { model, messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    trace.set(model, entry);
  }
  return entry;
}

function parseOpencodeSession(
  db: DatabaseSync,
  row: OpencodeRow,
  now: number,
): { session: SessionInfo; records: UsageRecord[] } {
  let modelObj: { id?: string; providerID?: string } | null = null;
  try {
    modelObj = row.model ? JSON.parse(row.model) as { id?: string; providerID?: string } : null;
  } catch { /* keep null */ }

  // Per-model trace from assistant message rows, deduplicated by id across
  // both opencode table generations.
  const trace = new Map<string, ModelTrace>();
  const records: UsageRecord[] = [];
  const seenIds = new Set<string>();

  let lastModel = modelLabel(modelObj);
  const msgRows = db.prepare(
    'SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC',
  ).all(row.id) as { id: string; data: string; time_created: number }[];

  for (const m of msgRows) {
    let data: {
      role?: string; modelID?: string; providerID?: string; finish?: string;
      tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
    };
    try {
      data = JSON.parse(m.data) as typeof data;
    } catch {
      continue;
    }
    if (data.role !== 'assistant' || !data.modelID) continue;
    if (m.id) seenIds.add(m.id);
    const label = providerLabel(data.providerID, data.modelID);
    lastModel = label;
    const entry = accModelTrace(trace, label);
    const t = data.tokens ?? {};
    const input = t.input ?? 0;
    const output = t.output ?? 0;
    const cacheRead = t.cache?.read ?? 0;
    const cacheWrite = t.cache?.write ?? 0;
    entry.messages += 1;
    entry.inputTokens += input;
    entry.outputTokens += output;
    entry.cacheReadTokens += cacheRead;
    entry.cacheWriteTokens += cacheWrite;
    records.push({
      source: 'opencode',
      sessionId: row.id,
      model: label,
      at: m.time_created,
      day: dayKey(m.time_created),
      input,
      output,
      cacheRead,
      cacheWrite,
      cacheTtlMs: 0,
      stopReason: data.finish === 'length' ? 'max_tokens' : undefined,
    });
  }

  try {
    const newRows = db.prepare(
      `SELECT id, data, time_created FROM session_message
       WHERE session_id = ? AND type = 'assistant' ORDER BY time_created ASC`,
    ).all(row.id) as { id: string; data: string; time_created: number }[];
    for (const m of newRows) {
      if (m.id && seenIds.has(m.id)) continue;
      if (m.id) seenIds.add(m.id);
      let data: {
        model?: { id?: string; providerID?: string }; finish?: string;
        tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
      };
      try {
        data = JSON.parse(m.data) as typeof data;
      } catch {
        continue;
      }
      const label = modelLabel(data.model);
      if (!label) continue;
      lastModel = label;
      const entry = accModelTrace(trace, label);
      const t = data.tokens ?? {};
      const input = t.input ?? 0;
      const output = t.output ?? 0;
      const cacheRead = t.cache?.read ?? 0;
      const cacheWrite = t.cache?.write ?? 0;
      entry.messages += 1;
      entry.inputTokens += input;
      entry.outputTokens += output;
      entry.cacheReadTokens += cacheRead;
      entry.cacheWriteTokens += cacheWrite;
      records.push({
        source: 'opencode',
        sessionId: row.id,
        model: label,
        at: m.time_created,
        day: dayKey(m.time_created),
        input,
        output,
        cacheRead,
        cacheWrite,
        cacheTtlMs: 0,
        stopReason: data.finish === 'length' ? 'max_tokens' : undefined,
      });
    }
  } catch {
    // session_message table absent in older opencode installs — legacy only
  }

  const msgTokens: SessionTokens = {
    input: row.tokens_input ?? 0,
    output: row.tokens_output ?? 0,
    reasoning: row.tokens_reasoning ?? 0,
    cacheRead: row.tokens_cache_read ?? 0,
    cacheWrite: row.tokens_cache_write ?? 0,
  };

  const updatedAt = row.time_updated;
  return {
    session: {
      source: 'opencode',
      id: row.id,
      project: row.directory ?? '',
      topic: truncate(row.title || '(no title)', 160),
      active: now - updatedAt <= ACTIVE_WINDOW_MS,
      createdAt: row.time_created,
      updatedAt,
      currentModel: lastModel,
      agent: row.agent ?? undefined,
      cost: row.cost ?? undefined,
      tokens: msgTokens,
      modelTrace: [...trace.values()].sort((a, b) => b.messages - a.messages),
    },
    records,
  };
}

async function collectOpencodeSessions(opts: CollectOptions, now: number): Promise<{ sessions: SessionInfo[]; records: UsageRecord[] }> {
  const dbPath = opts.opencodeDbPath ?? defaultOpencodeDbPath();
  if (!existsSync(dbPath)) return { sessions: [], records: [] };

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return { sessions: [], records: [] };
  }

  try {
    const rows = db.prepare(
      `SELECT id, title, directory, agent, model, cost,
              tokens_input, tokens_output, tokens_reasoning,
              tokens_cache_read, tokens_cache_write,
              time_created, time_updated
       FROM session
       ORDER BY time_updated DESC`,
    ).all() as unknown as OpencodeRow[];
    const sessions: SessionInfo[] = [];
    const records: UsageRecord[] = [];
    for (const row of rows) {
      const parsed = parseOpencodeSession(db, row, now);
      sessions.push(parsed.session);
      records.push(...parsed.records);
    }
    return { sessions, records };
  } finally {
    db.close();
  }
}

// ---- entry point -----------------------------------------------------------

/** All known sessions from both tools, plus per-request usage records. */
export async function collectUsage(opts: CollectOptions = {}): Promise<{ sessions: SessionInfo[]; records: UsageRecord[] }> {
  const now = opts.now ?? Date.now();
  const [claude, opencode] = await Promise.all([
    collectClaudeCodeSessions(opts, now),
    collectOpencodeSessions(opts, now),
  ]);
  const sessions = [...claude.sessions, ...opencode.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  return { sessions, records: [...claude.records, ...opencode.records] };
}

/** All known sessions from both tools, newest first. */
export async function collectSessions(opts: CollectOptions = {}): Promise<SessionInfo[]> {
  const { sessions } = await collectUsage(opts);
  return sessions;
}

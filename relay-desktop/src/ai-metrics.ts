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

async function parseClaudeSessionFile(file: string, now: number): Promise<SessionInfo | null> {
  let stat: Stats;
  try {
    stat = statSync(file);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }

  const acc: ClaudeAccumulator = { topic: null, project: null, createdAt: null, models: new Map() };
  let model: string | null = null;

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

      const type = obj.type;
      if (type === 'user' && acc.topic === null) {
        const msg = obj.message as { content?: unknown; role?: string } | undefined;
        if (msg?.role === 'user') acc.topic = truncate(claudeTopic(msg.content) ?? '', 160) || null;
      } else if (type === 'assistant') {
        const m = typeof obj.model === 'string' ? obj.model : null;
        if (m) {
          model = m;
          const entry = accModel(acc, m);
          entry.messages++;
          const u = obj.usage as
            | { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
            | undefined;
          entry.inputTokens += u?.input_tokens ?? 0;
          entry.outputTokens += u?.output_tokens ?? 0;
          entry.cacheReadTokens += u?.cache_read_input_tokens ?? 0;
          entry.cacheWriteTokens += u?.cache_creation_input_tokens ?? 0;
        }
      } else if (type === 'summary' && acc.topic === null) {
        const s = obj.summary;
        if (typeof s === 'string' && s.trim()) acc.topic = truncate(tidy(s), 160);
      }
    }
  } catch {
    return null;
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
    source: 'claude-code',
    id: basename(file, '.jsonl'),
    project: acc.project ?? '',
    topic: acc.topic,
    active: now - updatedAt <= ACTIVE_WINDOW_MS,
    createdAt: acc.createdAt ?? stat.birthtimeMs,
    updatedAt,
    currentModel: model ?? trace[0]?.model ?? '',
    tokens,
    modelTrace: trace,
  };
}

async function collectClaudeCodeSessions(opts: CollectOptions, now: number): Promise<SessionInfo[]> {
  const dir = opts.claudeProjectsDir ?? defaultClaudeProjectsDir();
  if (!existsSync(dir)) return [];

  let projects: string[];
  try {
    projects = readdirSync(dir);
  } catch {
    return [];
  }

  const sessions: SessionInfo[] = [];
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
    // Newest first, and only look at the tail so a fat project (dozens of
    // multi-MB transcripts) doesn't stall the popup. 25 per project is plenty
    // for an overview.
    const jsonls = files.filter(f => f.endsWith('.jsonl'))
      .map(f => join(projectDir, f))
      .sort((a, b) => statSyncSafe(b).mtimeMs - statSyncSafe(a).mtimeMs)
      .slice(0, 25);
    for (const file of jsonls) {
      const s = await parseClaudeSessionFile(file, now);
      if (s) sessions.push(s);
    }
  }
  return sessions;
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

function parseOpencodeSession(
  db: DatabaseSync,
  row: OpencodeRow,
  now: number,
): SessionInfo {
  let modelObj: { id?: string; providerID?: string } | null = null;
  try {
    modelObj = row.model ? JSON.parse(row.model) as { id?: string; providerID?: string } : null;
  } catch { /* keep null */ }

  // Per-model trace from message rows. assistant messages carry modelID +
  // tokens; cap the scan so one enormous session can't stall the popup.
  const trace = new Map<string, ModelTrace>();
  const msgRows = db.prepare(
    'SELECT data FROM message WHERE session_id = ? ORDER BY time_created ASC LIMIT 800',
  ).all(row.id) as { data: string }[];

  let lastModel = modelLabel(modelObj);
  let msgTokens: SessionTokens = { ...noTokens };
  for (const m of msgRows) {
    let data: { role?: string; modelID?: string; providerID?: string; tokens?: Record<string, unknown> };
    try {
      data = JSON.parse(m.data) as typeof data;
    } catch {
      continue;
    }
    if (data.role === 'assistant' && data.modelID) {
      const label = data.providerID && data.providerID !== 'opencode'
        ? `${data.providerID}/${data.modelID}`
        : data.modelID;
      lastModel = label;
      let entry = trace.get(label);
      if (!entry) {
        entry = { model: label, messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
        trace.set(label, entry);
      }
      entry.messages++;
      const t = (data.tokens ?? {}) as {
        input?: number; output?: number; reasoning?: number;
        cache?: { read?: number; write?: number };
      };
      entry.inputTokens += t.input ?? 0;
      entry.outputTokens += t.output ?? 0;
      entry.cacheReadTokens += t.cache?.read ?? 0;
      entry.cacheWriteTokens += t.cache?.write ?? 0;
    }
  }

  msgTokens = {
    input: row.tokens_input ?? 0,
    output: row.tokens_output ?? 0,
    reasoning: row.tokens_reasoning ?? 0,
    cacheRead: row.tokens_cache_read ?? 0,
    cacheWrite: row.tokens_cache_write ?? 0,
  };

  const updatedAt = row.time_updated;
  return {
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
  };
}

async function collectOpencodeSessions(opts: CollectOptions, now: number): Promise<SessionInfo[]> {
  const dbPath = opts.opencodeDbPath ?? defaultOpencodeDbPath();
  if (!existsSync(dbPath)) return [];

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
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
    return rows.map(row => parseOpencodeSession(db, row, now));
  } finally {
    db.close();
  }
}

// ---- entry point -----------------------------------------------------------

/** All known sessions from both tools, newest first. */
export async function collectSessions(opts: CollectOptions = {}): Promise<SessionInfo[]> {
  const now = opts.now ?? Date.now();
  const [claude, opencode] = await Promise.all([
    collectClaudeCodeSessions(opts, now),
    collectOpencodeSessions(opts, now),
  ]);
  return [...claude, ...opencode].sort((a, b) => b.updatedAt - a.updatedAt);
}

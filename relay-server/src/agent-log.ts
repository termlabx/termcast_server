// The daemon's own tail of agent traffic, for the Web UI's Agent Log page.
//
// The desktop tray builds the same view by parsing the `[agent] …` lines off
// the daemon's stdout (relay-desktop/src/server-agent-log-parser.ts). A CLI
// install has nobody reading that stdout — on a headless Linux box it goes to a
// rotated log file — so the daemon keeps the structured records itself, at the
// point where the line is written, and serves them. No parsing, and no chance
// of the two views disagreeing about what a frame contained.
//
// The row shape deliberately mirrors the tray's (agent-log-format.ts): same
// columns, same clipping, same short session ids, so the two are one feature.

/** One rendered row of the Agent Log. */
export interface AgentLogRow {
  /** Monotonic across the process; a poller sends back the last it saw. */
  seq: number;
  /** HH:MM:SS.mmm, local. */
  time: string;
  /** in = phone→server, out = server→phone. */
  direction: 'in' | 'out';
  /** "<agent> <session…>", or "conn <n>" when there is no session. */
  scope: string;
  /** Frame type, with a status value folded in. */
  type: string;
  /** The payload bits worth reading at a glance. */
  detail: string;
  /** Every visible part, lowercased, for the page's filter box. */
  search: string;
}

/** Long prompts and pasted diffs would otherwise make one row taller than the
 *  page; the full payload is on the wire, this view is a trace. */
const MAX_DETAIL = 280;

function clip(text: string): string {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
}

function quoted(text: string): string {
  return text.length > MAX_DETAIL ? `"${text.slice(0, MAX_DETAIL)}…"` : `"${text}"`;
}

/** Session ids are long and only the head distinguishes them in practice. */
function shortSession(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function formatScope(fields: Record<string, unknown>): string {
  const agent = str(fields.agent);
  const session = str(fields.session);
  if (session) return agent ? `${agent} ${shortSession(session)}` : shortSession(session);
  if (agent) return agent;
  return fields.conn !== undefined ? `conn ${fields.conn}` : '';
}

function formatDetail(fields: Record<string, unknown>): string {
  const parts: string[] = [];
  const push = (key: string, render: (value: unknown) => string) => {
    if (fields[key] !== undefined) parts.push(render(fields[key]));
  };

  push('requestId', String);
  push('behavior', String);
  if (fields.rejected) parts.push('rejected');
  if (Array.isArray(fields.answers)) parts.push(JSON.stringify(fields.answers));
  if (str(fields.detail) !== undefined) parts.push(clip(String(fields.detail)));
  if (str(fields.prompt) !== undefined) parts.push(quoted(String(fields.prompt)));
  if (str(fields.text) !== undefined) parts.push(quoted(String(fields.text)));
  // The terminal-attach line names a multiplexer session rather than an agent one.
  if (fields.kind !== undefined || fields.name !== undefined) {
    parts.push([fields.kind, fields.name].filter(Boolean).join(':'));
  }
  push('messageId', (v) => `msg=${v}`);
  push('seq', (v) => `seq=${v}`);
  push('sinceSeq', (v) => `sinceSeq=${v}`);
  push('beforeSeq', (v) => `beforeSeq=${v === null ? 'null' : v}`);
  push('limit', (v) => `limit=${v}`);
  push('count', (v) => `count=${v}`);
  return parts.join(' ');
}

function formatTime(when: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}.${pad(when.getMilliseconds(), 3)}`;
}

/**
 * Bounded in-memory tail of agent traffic.
 *
 * Rows are rendered on the way in: the fields object belongs to the caller and
 * a later mutation of it must not rewrite history.
 */
export class AgentLogRing {
  private rowsBuffer: AgentLogRow[] = [];
  private nextSeq = 1;

  constructor(private readonly max: number) {}

  /** Render and keep one `[agent]` line. `dir` is as the log line writes it. */
  record(dir: '->' | '<-', fields: Record<string, unknown>, when: Date = new Date()): void {
    const scope = formatScope(fields);
    const value = str(fields.value);
    const base = str(fields.type) ?? 'event';
    // "status" alone says nothing; the value is the part a reader is scanning for.
    const type = base === 'status' && value ? `${base} ${value}` : base;
    const detail = formatDetail(fields);
    this.rowsBuffer.push({
      seq: this.nextSeq++,
      time: formatTime(when),
      direction: dir === '->' ? 'in' : 'out',
      scope,
      type,
      detail,
      search: `${scope} ${type} ${detail}`.trim().toLowerCase(),
    });
    if (this.rowsBuffer.length > this.max) {
      this.rowsBuffer.splice(0, this.rowsBuffer.length - this.max);
    }
  }

  rows(): AgentLogRow[] {
    return this.rowsBuffer.slice();
  }

  /** Everything newer than `seq`. A poller passes the last seq it rendered. */
  rowsSince(seq: number): AgentLogRow[] {
    return this.rowsBuffer.filter((row) => row.seq > seq);
  }

  /** Highest seq issued so far, whether or not that row is still buffered. */
  get lastSeq(): number {
    return this.nextSeq - 1;
  }
}

/** Rows kept for a page opened long after the traffic happened. */
const DEFAULT_CAPACITY = 500;

/**
 * The process-wide log. A module singleton because the writer is bridge.ts's
 * `agentLog()` — a free function called from a dozen frame handlers — and
 * threading a ring through every one of them would buy nothing.
 */
export const agentLogRing = new AgentLogRing(DEFAULT_CAPACITY);

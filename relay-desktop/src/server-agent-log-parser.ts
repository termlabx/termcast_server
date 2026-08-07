// Parses the relay-server's stdout into structured agent-traffic events for the
// tray's Agent Log window. The server emits one "[agent] <dir> k=v k=v ..." line
// per agent frame and one "[attach] ..." line per terminal attach decision (see
// relay-server/src/bridge.ts). Values that may contain spaces are JSON-quoted,
// and array values are JSON-encoded, so the tokenizer below can split on
// whitespace without a value ever spilling into the next key.

export interface AgentLogEvent {
  timestamp: string;
  direction: 'in' | 'out'; // phone→server / server→phone
  connId?: number;
  agent?: string;
  sessionId?: string;
  type: string;
  value?: string;      // status value (turn_start / turn_end / error)
  detail?: string;
  text?: string;
  prompt?: string;
  requestId?: string;
  messageId?: string;
  behavior?: string;
  answers?: string[];
  rejected?: boolean;
  seq?: number;
  sinceSeq?: number;
  beforeSeq?: number | null;
  limit?: number;
  count?: number;
  kind?: string;       // terminal attach kind
  name?: string;       // terminal attach session name
  target?: string;     // [attach] target
  mux?: string;        // [attach] multiplexer
}

// A value is either a JSON string, a JSON array (which may contain spaces
// inside its quoted entries), or a bare whitespace-free token.
const KV = /(\w+)=(?:"((?:\\.|[^"])*)"|(\[(?:"(?:\\.|[^"])*"|[^\]"])*\])|(\S+))/g;
const NUMERIC = new Set(['seq', 'sinceSeq', 'limit', 'count']);

function tokenValue(raw: string): unknown {
  // `answers=["a","b"]` and other JSON arrays arrive unquoted.
  if (raw.startsWith('[')) {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

function parseFields(rest: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const match of rest.matchAll(KV)) {
    const key = match[1];
    // A quoted value is a JSON string body: unescape it the same way it was written.
    const quoted = match[2] !== undefined;
    const raw = quoted ? match[2] : (match[3] ?? match[4]);
    if (quoted) {
      try { fields[key] = JSON.parse(`"${raw}"`); } catch { fields[key] = raw; }
      continue;
    }
    if (key === 'beforeSeq') { fields.beforeSeq = raw === 'null' ? null : Number(raw); continue; }
    if (key === 'conn') { fields.connId = Number(raw); continue; }
    if (key === 'session') { fields.sessionId = raw; continue; }
    if (NUMERIC.has(key)) { fields[key] = Number(raw); continue; }
    fields[key] = tokenValue(raw);
  }
  return fields;
}

function toEvent(fields: Record<string, unknown>, direction: 'in' | 'out', timestamp: string): AgentLogEvent {
  return { timestamp, direction, ...fields } as unknown as AgentLogEvent;
}

export function parseAgentLogEvents(chunk: string): AgentLogEvent[] {
  const timestamp = new Date().toISOString();
  const events: AgentLogEvent[] = [];
  for (const raw of chunk.split('\n')) {
    const line = raw.trimEnd();
    const agent = line.match(/^\[agent\] (->|<-)\s+(.*)$/);
    if (agent) {
      const direction = agent[1] === '->' ? 'in' : 'out';
      const fields = parseFields(agent[2]);
      if (typeof fields.type !== 'string') fields.type = 'event';
      events.push(toEvent(fields, direction, timestamp));
      continue;
    }
    const attach = line.match(/^\[attach\]\s+(.*)$/);
    if (attach) {
      const fields = parseFields(attach[1]);
      fields.type = 'attach-terminal';
      events.push(toEvent(fields, 'in', timestamp));
    }
  }
  return events;
}

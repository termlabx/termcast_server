import type { AgentLogEvent } from './server-agent-log-parser.js';

/** One rendered row of the Agent Log window. Kept free of Electron imports so
 *  the formatting is unit-testable; the window module only paints these. */
export interface AgentLogRow {
  time: string;      // HH:MM:SS.mmm, local
  direction: 'in' | 'out';
  scope: string;     // "<agent> <session…>", or "conn <n>" when there is no session
  type: string;      // frame type, with the status value folded in
  detail: string;    // the payload bits worth reading at a glance
  search: string;    // every part lowercased, for the filter box
}

/** Long prompts and pasted diffs would otherwise make one row taller than the
 *  window; the full payload is on the wire, this view is a trace. */
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

function formatScope(event: AgentLogEvent): string {
  if (event.sessionId) {
    return event.agent ? `${event.agent} ${shortSession(event.sessionId)}` : shortSession(event.sessionId);
  }
  if (event.agent) return event.agent;
  return event.connId !== undefined ? `conn ${event.connId}` : '';
}

function formatDetail(event: AgentLogEvent): string {
  const parts: string[] = [];
  if (event.requestId) parts.push(event.requestId);
  if (event.behavior) parts.push(event.behavior);
  if (event.rejected) parts.push('rejected');
  if (event.answers) parts.push(JSON.stringify(event.answers));
  if (event.detail) parts.push(clip(event.detail));
  if (event.prompt !== undefined) parts.push(quoted(event.prompt));
  if (event.text !== undefined) parts.push(quoted(event.text));
  if (event.target) parts.push(event.mux ? `${event.target} (${event.mux})` : event.target);
  else if (event.kind || event.name) parts.push([event.kind, event.name].filter(Boolean).join(':'));
  if (event.messageId) parts.push(`msg=${event.messageId}`);
  if (event.seq !== undefined) parts.push(`seq=${event.seq}`);
  if (event.sinceSeq !== undefined) parts.push(`sinceSeq=${event.sinceSeq}`);
  if (event.beforeSeq !== undefined) parts.push(`beforeSeq=${event.beforeSeq === null ? 'null' : event.beforeSeq}`);
  if (event.limit !== undefined) parts.push(`limit=${event.limit}`);
  if (event.count !== undefined) parts.push(`count=${event.count}`);
  return parts.join(' ');
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function formatAgentLogRow(event: AgentLogEvent): AgentLogRow {
  const scope = formatScope(event);
  // `status` alone says nothing; the value (turn_start / turn_end / error) is
  // the part a reader is scanning for, so it belongs in the type column.
  const type = event.type === 'status' && event.value ? `${event.type} ${event.value}` : event.type;
  const detail = formatDetail(event);
  return {
    time: formatTime(event.timestamp),
    direction: event.direction,
    scope,
    type,
    detail,
    search: `${scope} ${type} ${detail}`.toLowerCase(),
  };
}

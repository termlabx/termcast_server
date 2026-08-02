/**
 * The normalized vocabulary shared by every agent adapter and sent to the
 * phone. Nothing agent-specific crosses this boundary: the phone never learns
 * that Claude Code keeps JSONL on disk or that opencode answers over HTTP.
 */

export type AgentKind = 'claude' | 'opencode';

export type MessageRole = 'user' | 'assistant' | 'system';

/**
 * One renderable piece of a message. Tool inputs and results are truncated by
 * the adapter before they get here — a whole file does not belong in a chat
 * bubble, and the frame path should not carry one.
 */
export type MessageBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; durationMs?: number }
  | { kind: 'toolUse'; toolUseId: string; name: string; summary: string; input: string; truncated: boolean }
  | { kind: 'toolResult'; toolUseId: string; ok: boolean; preview: string; truncated: boolean }
  | { kind: 'diff'; file: string; added: number; removed: number; patch: string; truncated: boolean };

export interface AgentMessage {
  /** Stable within a session. The agent's own id where it has one. */
  id: string;
  /**
   * Monotonic position within the session, assigned by the adapter rather than
   * the transport so it survives a termcastd restart. Claude Code uses the
   * transcript line index; opencode uses the message ordinal.
   */
  seq: number;
  role: MessageRole;
  /** ISO 8601, or null for records the agent wrote without one. */
  timestamp: string | null;
  blocks: MessageBlock[];
}

export interface AgentSessionSummary {
  id: string;
  agent: AgentKind;
  title: string;
  projectPath: string;
  lastActiveAt: string | null;
  isLive: boolean;
  messageCount: number;
  model: string | null;
  /** True when a permission request is waiting on an answer. */
  needsAttention: boolean;
}

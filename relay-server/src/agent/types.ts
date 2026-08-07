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
  /**
   * True only for a user turn the agent has accepted but not answered yet —
   * opencode queues a prompt sent while a turn is still running, so the
   * message is real and on screen while its reply is not. Absent/false for
   * everything else; a turn is "answered" once a completed assistant message
   * follows it.
   */
  pending?: boolean;
}

export interface AgentSessionSummary {
  id: string;
  agent: AgentKind;
  title: string;
  projectPath: string;
  lastActiveAt: string | null;
  isLive: boolean;
  /**
   * Null when unknown. Listing reads only a slice of each transcript, so an
   * exact count is not available until the session is opened — and an estimate
   * derived from the slice would be worse than an honest absence.
   */
  messageCount: number | null;
  model: string | null;
  /** True when a permission request is waiting on an answer. */
  needsAttention: boolean;
}

export interface AgentQuestionOption {
  label: string;
  description?: string;
}

export interface AgentQuestionInfo {
  requestId: string;
  sessionId: string;
  agent: AgentKind;
  prompt: string;
  kind: 'select' | 'freeform';
  options: AgentQuestionOption[];
  createdAt: string;
}

export interface AgentQuestion extends AgentQuestionInfo {
  answers?: string[];
  rejected?: boolean;
}

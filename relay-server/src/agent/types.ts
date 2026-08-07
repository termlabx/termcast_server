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
  /**
   * False when the session is running somewhere we cannot type into — an
   * opencode TUI in tmux, say, which publishes no session→pane signal. Such a
   * session is readable but cannot take a message; `send` refuses it.
   *
   * Optional so a phone that predates the flag simply shows the session and
   * gets the server's refusal on send — the same outcome, one step later.
   */
  reachable?: boolean;
}

export interface AgentQuestionOption {
  label: string;
  description?: string;
  /**
   * 1-based row in the desk dialog this label maps to. Absent off-desk.
   *
   * Carrying it is what lets a correlated question key off position rather than
   * re-matching labels, which a TUI truncates whenever they outrun the pane.
   */
  index?: number;
}

/**
 * Where a question came from, which decides how the phone must present it.
 *
 * `desk` is a dialog the agent drew in a pane at the user's keyboard: it is
 * answered with a single keystroke, so exactly one option can be picked and
 * declining means pressing Escape over there. `agent` is a question the agent
 * asked through its own tooling, which has always allowed several answers.
 *
 * Optional: a phone that predates it treats every question as `agent`, which is
 * the behaviour it already had.
 */
export type AgentQuestionOrigin = 'desk' | 'agent';

export interface AgentQuestionInfo {
  requestId: string;
  sessionId: string;
  agent: AgentKind;
  prompt: string;
  /** AskUserQuestion's short label, e.g. "Auth method". */
  header?: string;
  kind: 'select' | 'freeform';
  options: AgentQuestionOption[];
  /**
   * Whether the far end genuinely accepts several answers. Absent means false.
   *
   * Before this field the phone guessed from `origin`, so every agent question
   * rendered as checkboxes and every desk question as radios, regardless of
   * what the agent actually asked for.
   */
  multiSelect?: boolean;
  /** Free text accepted instead of a listed option; drives the "Other…" row. */
  allowsOther?: boolean;
  /**
   * One AskUserQuestion call carries up to four questions. They share a
   * groupId so the phone can show "2 of 3" and the caller knows the tool result
   * is not complete until every member has been answered.
   */
  groupId?: string;
  groupIndex?: number;
  groupCount?: number;
  createdAt: string;
  /** Absent means `agent`; see AgentQuestionOrigin. */
  origin?: AgentQuestionOrigin;
}

export interface AgentQuestion extends AgentQuestionInfo {
  answers?: string[];
  rejected?: boolean;
}

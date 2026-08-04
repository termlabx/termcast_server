import type { AgentKind, AgentMessage, AgentSessionSummary, AgentQuestionInfo } from './types.js';

/** A tool call waiting on a human decision. */
export interface AgentPermissionRequest {
  requestId: string;
  sessionId: string;
  agent: AgentKind;
  toolName: string;
  toolUseId: string;
  /** One-line label for the card, e.g. "npm test". */
  summary: string;
  /** JSON tool input, truncated to MAX_BLOCK_CHARS. */
  input: string;
  truncated: boolean;
  createdAt: string;
}

export type PermissionBehavior = 'allow' | 'deny';

export type AgentEvent =
  | { kind: 'message'; sessionId: string; seq: number; message: AgentMessage }
  | { kind: 'delta'; sessionId: string; messageId: string; text: string }
  | { kind: 'status'; sessionId: string; seq: number; status: 'turn_start' | 'turn_end' | 'ended' | 'error'; detail?: string }
  | { kind: 'permission'; sessionId: string; seq: number; request: AgentPermissionRequest }
  | { kind: 'question'; sessionId: string; seq: number; request: AgentQuestionInfo }
  | { kind: 'history'; sessionId: string; beforeSeq: number | null; hasMore: boolean; messages: AgentMessage[] };

export interface HistoryPage {
  messages: AgentMessage[];
  hasMore: boolean;
}

export type Unsubscribe = () => void;

/**
 * One agent's integration. Every agent-specific detail — JSONL layout, HTTP
 * routes, keystroke injection — lives behind this and never crosses the wire.
 */
export interface AgentAdapter {
  readonly kind: AgentKind;
  /** Sessions this agent knows about, newest first. Never throws; returns [] when the agent is absent. */
  list(): Promise<AgentSessionSummary[]>;
  /** A page of messages ending before `beforeSeq` (null = most recent page). */
  history(sessionId: string, beforeSeq: number | null, limit: number): Promise<HistoryPage>;
  /** Stream events after `sinceSeq`. Returns a function that stops the stream. */
  subscribe(sessionId: string, sinceSeq: number, onEvent: (event: AgentEvent) => void): Promise<Unsubscribe>;
  /** Deliver a user message. Phase 2. */
  send(sessionId: string, text: string): Promise<void>;
  /** Stop the running turn. Phase 2. */
  interrupt(sessionId: string): Promise<void>;
  /** Answer a pending permission. Phase 3. */
  respondPermission(requestId: string, behavior: PermissionBehavior): Promise<void>;
  /** Answer a pending question. */
  respondQuestion(requestId: string, answers?: string[], rejected?: boolean): Promise<void>;
}

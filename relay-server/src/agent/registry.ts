import type { AgentAdapter, AgentEvent, HistoryPage, Unsubscribe } from './adapter.js';
import type { AgentKind, AgentQuestionInfo, AgentSessionSummary } from './types.js';
import { SessionLiveness } from './session-liveness.js';
import { defaultDeskRegistry, type DeskRegistry } from './desk-target.js';

/**
 * Fans requests out across the installed adapters and routes by (agent, id).
 * Session ids are only unique within one agent, so the agent kind is part of
 * every route.
 *
 * Adapters may be given as a provider function so an adapter can appear (or
 * vanish) between requests — e.g. opencode is discovered lazily, so a server
 * that started before opencode was available still picks it up on the next
 * session listing without a restart.
 */
export interface AgentRegistryDeps {
  desk?: DeskRegistry;
  liveness?: SessionLiveness;
}

export class AgentRegistry {
  private readonly adapters: AgentAdapter[] | (() => AgentAdapter[]);
  private readonly desk: DeskRegistry;
  private readonly liveness: SessionLiveness;

  constructor(adapters: AgentAdapter[] | (() => AgentAdapter[]), deps: AgentRegistryDeps = {}) {
    this.adapters = adapters;
    this.desk = deps.desk ?? defaultDeskRegistry();
    this.liveness = deps.liveness ?? new SessionLiveness();
  }

  private currentAdapters(): AgentAdapter[] {
    return typeof this.adapters === 'function' ? this.adapters() : this.adapters;
  }

  adapterFor(kind: AgentKind): AgentAdapter | null {
    return this.currentAdapters().find((a) => a.kind === kind) ?? null;
  }

  /**
   * An adapter that throws contributes nothing rather than failing the whole
   * list: one broken agent must not hide the other's sessions.
   *
   * Every session is listed; `reachable` says whether it can take a message.
   * It can when it is reachable at the desk, or when nothing holds it and a
   * headless resume is honest.
   *
   * A session running somewhere we cannot type into used to be hidden outright,
   * on the grounds that offering it would mean answering on the phone while the
   * user's own terminal showed nothing. But `send` already refuses exactly that
   * case with an explanation, so hiding was a second guard whose only remaining
   * effect was to cost the user the ability to *read* the session — and an
   * opencode TUI in tmux, which has no session→pane signal to route by, made
   * every opencode session in that project disappear.
   */
  async list(): Promise<AgentSessionSummary[]> {
    const results = await Promise.all(
      this.currentAdapters().map(async (adapter) => {
        try {
          return await adapter.list();
        } catch {
          return [];
        }
      }),
    );

    const sorted = results
      .flat()
      .sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''));

    const entries = await this.desk.list();
    const reachable = new Set(entries.map((entry) => `${entry.agent} ${entry.sessionId}`));
    // `blocked` is the desk equivalent of a pending permission: the agent has
    // drawn a dialog and is waiting on a human. needsAttention already means
    // exactly that, so it carries this rather than earning a second flag.
    const blocked = new Set(
      entries
        .filter((entry) => entry.target.status === 'blocked')
        .map((entry) => `${entry.agent} ${entry.sessionId}`),
    );

    const visible: AgentSessionSummary[] = [];
    for (const session of sorted) {
      const key = `${session.agent} ${session.id}`;
      if (reachable.has(key)) {
        visible.push({
          ...session, isLive: true, reachable: true,
          needsAttention: session.needsAttention || blocked.has(key),
        });
        continue;
      }
      const alive = await this.liveness.isAlive(session.agent, session.id, session.projectPath);
      visible.push({ ...session, isLive: alive, reachable: !alive });
    }
    return visible;
  }

  async history(kind: AgentKind, sessionId: string, beforeSeq: number | null, limit: number): Promise<HistoryPage> {
    const adapter = this.adapterFor(kind);
    if (!adapter) return { messages: [], hasMore: false };
    try {
      return await adapter.history(sessionId, beforeSeq, limit);
    } catch {
      return { messages: [], hasMore: false };
    }
  }

  async subscribe(kind: AgentKind, sessionId: string, sinceSeq: number, onEvent: (event: AgentEvent) => void): Promise<Unsubscribe> {
    const adapter = this.adapterFor(kind);
    if (!adapter) return () => {};

    const wrapped = (event: AgentEvent): void => {
      this.trackQuestion(event);
      onEvent(event);
    };

    try {
      const stop = await adapter.subscribe(sessionId, sinceSeq, wrapped);
      // Replayed after the adapter is up, so a reattaching phone sees its
      // outstanding cards alongside the history it asked for. The relay drops
      // and reconnects routinely, and a question that outlived the socket is
      // still holding the agent — without this it holds it invisibly.
      for (const request of this.pendingQuestions(sessionId)) {
        onEvent({ kind: 'question', sessionId, seq: request.groupIndex ?? 0, request });
      }
      return stop;
    } catch {
      return () => {};
    }
  }

  /**
   * Questions raised but not yet resolved, keyed by session.
   *
   * Deliberately mirrors the event stream rather than asking the adapters:
   * `canUseTool` promises, desk dialogs and opencode's question API have three
   * different lifecycles, and the one thing they share is that they all announce
   * themselves here.
   */
  private readonly liveQuestions = new Map<string, Map<string, AgentQuestionInfo>>();

  private trackQuestion(event: AgentEvent): void {
    if (event.kind === 'question') {
      const forSession = this.liveQuestions.get(event.sessionId) ?? new Map();
      forSession.set(event.request.requestId, event.request);
      this.liveQuestions.set(event.sessionId, forSession);
    } else if (event.kind === 'questionResolved') {
      this.liveQuestions.get(event.sessionId)?.delete(event.requestId);
    }
  }

  /** Outstanding questions for a session, oldest first. */
  pendingQuestions(sessionId: string): AgentQuestionInfo[] {
    return [...(this.liveQuestions.get(sessionId)?.values() ?? [])];
  }
}

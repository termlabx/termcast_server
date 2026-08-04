import type { AgentAdapter, AgentEvent, HistoryPage, Unsubscribe } from './adapter.js';
import type { AgentKind, AgentSessionSummary } from './types.js';
import { readLiveSessions, applyLiveness } from './session-registry.js';

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
export class AgentRegistry {
  private readonly adapters: AgentAdapter[] | (() => AgentAdapter[]);

  constructor(adapters: AgentAdapter[] | (() => AgentAdapter[])) {
    this.adapters = adapters;
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

    return applyLiveness(
      results
        .flat()
        .sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? '')),
      readLiveSessions(),
    );
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
    try {
      return await adapter.subscribe(sessionId, sinceSeq, onEvent);
    } catch {
      return () => {};
    }
  }
}

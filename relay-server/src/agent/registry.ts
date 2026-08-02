import type { AgentAdapter, AgentEvent, HistoryPage, Unsubscribe } from './adapter.js';
import type { AgentKind, AgentSessionSummary } from './types.js';

/**
 * Fans requests out across the installed adapters and routes by (agent, id).
 * Session ids are only unique within one agent, so the agent kind is part of
 * every route.
 */
export class AgentRegistry {
  constructor(private readonly adapters: AgentAdapter[]) {}

  adapterFor(kind: AgentKind): AgentAdapter | null {
    return this.adapters.find((a) => a.kind === kind) ?? null;
  }

  /**
   * An adapter that throws contributes nothing rather than failing the whole
   * list: one broken agent must not hide the other's sessions.
   */
  async list(): Promise<AgentSessionSummary[]> {
    const results = await Promise.all(
      this.adapters.map(async (adapter) => {
        try {
          return await adapter.list();
        } catch {
          return [];
        }
      }),
    );

    return results
      .flat()
      .sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''));
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

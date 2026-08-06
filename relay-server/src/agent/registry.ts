import type { AgentAdapter, AgentEvent, HistoryPage, Unsubscribe } from './adapter.js';
import type { AgentKind, AgentSessionSummary } from './types.js';
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
   * A session is listed when we can deliver a message somewhere the user will
   * see it — either it is reachable at the desk, or nothing holds it and a
   * headless resume is honest. A session that is running somewhere we cannot
   * type into is hidden, because offering it would mean answering on the phone
   * while the user's own terminal shows nothing.
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

    const reachable = new Set(
      (await this.desk.list()).map((entry) => `${entry.agent} ${entry.sessionId}`),
    );

    const visible: AgentSessionSummary[] = [];
    for (const session of sorted) {
      if (reachable.has(`${session.agent} ${session.id}`)) {
        visible.push({ ...session, isLive: true });
        continue;
      }
      if (!(await this.liveness.isAlive(session.agent, session.id, session.projectPath))) {
        visible.push({ ...session, isLive: false });
      }
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
    try {
      return await adapter.subscribe(sessionId, sinceSeq, onEvent);
    } catch {
      return () => {};
    }
  }
}

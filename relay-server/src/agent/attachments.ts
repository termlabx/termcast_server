import type { AgentEvent, Unsubscribe } from './adapter.js';
import type { AgentRegistry } from './registry.js';
import type { AgentKind } from './types.js';

interface Attachment {
  sessionId: string;
  kind: AgentKind;
  unsubscribe: Unsubscribe;
}

/**
 * Tracks which relay connection is watching which session.
 *
 * A connection holds at most one attachment: re-attaching replaces the old
 * subscription rather than stacking a second one. Leaking a subscription per
 * reconnect is exactly the failure mode that drained battery through the
 * bridge's session map.
 */
export class AttachmentManager {
  private readonly byConn = new Map<number, Attachment>();

  constructor(private readonly registry: AgentRegistry) {}

  async attach(
    connId: number,
    kind: AgentKind,
    sessionId: string,
    sinceSeq: number,
    onEvent: (event: AgentEvent) => void,
  ): Promise<void> {
    this.detach(connId);
    const unsubscribe = await this.registry.subscribe(kind, sessionId, sinceSeq, onEvent);
    this.byConn.set(connId, { sessionId, kind, unsubscribe });
  }

  detach(connId: number): void {
    const attachment = this.byConn.get(connId);
    if (!attachment) return;
    this.byConn.delete(connId);
    try {
      attachment.unsubscribe();
    } catch {
      // A failing unsubscribe must not block teardown of the rest.
    }
  }

  detachAll(): void {
    for (const connId of [...this.byConn.keys()]) this.detach(connId);
  }

  /** Session ids currently being watched, deduplicated. */
  attachedSessions(): string[] {
    return [...new Set([...this.byConn.values()].map((a) => a.sessionId))];
  }

  isAttached(sessionId: string): boolean {
    return [...this.byConn.values()].some((a) => a.sessionId === sessionId);
  }
}

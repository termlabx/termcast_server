import type { AgentAdapter, AgentEvent, HistoryPage, PermissionBehavior, Unsubscribe } from './adapter.js';
import type { AgentSessionSummary } from './types.js';
import type { OpencodeClient } from './opencode-client.js';

/** Thrown by capabilities not yet built, so a caller never mistakes a no-op for success. */
export class AgentUnsupportedError extends Error {
  constructor(what: string) {
    super(`${what} is not supported yet`);
    this.name = 'AgentUnsupportedError';
  }
}

const POLL_MS = 1000;

export class OpencodeAdapter implements AgentAdapter {
  readonly kind = 'opencode' as const;

  constructor(private readonly client: OpencodeClient) {}

  list(): Promise<AgentSessionSummary[]> {
    return this.client.listSessions();
  }

  async history(sessionId: string, beforeSeq: number | null, limit: number): Promise<HistoryPage> {
    const all = await this.client.listMessages(sessionId);
    const end = beforeSeq === null ? all.length : all.findIndex((m) => m.seq === beforeSeq);
    const stop = end < 0 ? all.length : end;
    const start = Math.max(0, stop - limit);
    return { messages: all.slice(start, stop), hasMore: start > 0 };
  }

  /**
   * Phase 1 polls the message list. Phase 4 replaces this with the /api/event
   * SSE stream; the callback contract is identical, so nothing above changes.
   */
  async subscribe(sessionId: string, sinceSeq: number, onEvent: (event: AgentEvent) => void): Promise<Unsubscribe> {
    let lastSeq = sinceSeq;
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      for (const message of await this.client.listMessages(sessionId)) {
        if (stopped) return;
        if (message.seq <= lastSeq) continue;
        lastSeq = message.seq;
        onEvent({ kind: 'message', sessionId, seq: message.seq, message });
      }
    };

    const timer = setInterval(() => { void tick(); }, POLL_MS);
    void tick();

    return () => { stopped = true; clearInterval(timer); };
  }

  send(sessionId: string, text: string): Promise<void> {
    return this.client.sendMessage(sessionId, text);
  }

  interrupt(sessionId: string): Promise<void> {
    return this.client.interrupt(sessionId);
  }

  async respondPermission(_requestId: string, _behavior: PermissionBehavior): Promise<void> {
    throw new AgentUnsupportedError('opencode permissions');
  }
}

import type { AgentPermissionRequest, PermissionBehavior } from './adapter.js';

/** "unanswered" means fall through to the agent's own prompt. */
export type PermissionOutcome = PermissionBehavior | 'unanswered';

/** Inside Claude Code's 600s hook timeout, so our answer always lands first. */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 540_000;

interface Waiter {
  request: AgentPermissionRequest;
  settle: (outcome: PermissionOutcome) => void;
  timer: NodeJS.Timeout;
}

/**
 * Holds tool-approval requests while a phone decides.
 *
 * The broker never invents an approval. Every path that is not an explicit
 * human tap — timeout, detach, shutdown — resolves to "unanswered", which the
 * caller turns into a fall-through to the agent's own terminal prompt.
 */
export class PermissionBroker {
  private readonly waiters = new Map<string, Waiter>();
  private readonly listeners: Array<(request: AgentPermissionRequest) => void> = [];

  onRequest(callback: (request: AgentPermissionRequest) => void): void {
    this.listeners.push(callback);
  }

  request(request: AgentPermissionRequest, timeoutMs: number = DEFAULT_PERMISSION_TIMEOUT_MS): Promise<PermissionOutcome> {
    return new Promise<PermissionOutcome>((resolve) => {
      const settle = (outcome: PermissionOutcome) => {
        const waiter = this.waiters.get(request.requestId);
        if (!waiter) return;          // already settled
        clearTimeout(waiter.timer);
        this.waiters.delete(request.requestId);
        resolve(outcome);
      };

      const timer = setTimeout(() => settle('unanswered'), timeoutMs);
      // Never hold process exit open for a pending approval.
      timer.unref?.();

      this.waiters.set(request.requestId, { request, settle, timer });

      for (const listener of this.listeners) {
        try {
          listener(request);
        } catch {
          // A failing listener must not block the others or the request.
        }
      }
    });
  }

  resolve(requestId: string, behavior: PermissionBehavior): void {
    this.waiters.get(requestId)?.settle(behavior);
  }

  /** Called when the last attached phone goes away. */
  releaseAll(): void {
    for (const waiter of [...this.waiters.values()]) waiter.settle('unanswered');
  }

  pending(): AgentPermissionRequest[] {
    return [...this.waiters.values()].map((waiter) => waiter.request);
  }
}

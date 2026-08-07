import type { AgentLogEvent } from './server-agent-log-parser.js';

/** Bounded in-memory tail of agent-traffic events for the Agent Log window.
 *  The window can be opened long after the traffic happened, so the ring keeps
 *  the recent history that a freshly loaded window replays. */
export class AgentLogRing {
  private items: AgentLogEvent[] = [];
  constructor(private readonly max: number) {}

  push(event: AgentLogEvent): void {
    this.items.push(event);
    if (this.items.length > this.max) {
      this.items.splice(0, this.items.length - this.max);
    }
  }

  all(): AgentLogEvent[] {
    return this.items.slice();
  }
}

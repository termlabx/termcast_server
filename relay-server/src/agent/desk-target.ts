import type { AgentKind } from './types.js';
import type { Multiplexer } from '../multiplexer.js';
import { HerdrAgentCli, type HerdrStatus } from './herdr-agent-cli.js';
import { readLiveSessions, type LiveSession } from './session-registry.js';

export interface DeskTarget {
  /** herdr "wB:p1" or tmux "%12" — whatever that multiplexer's send command takes. */
  paneId: string;
  mux: 'herdr' | 'tmux';
  status: HerdrStatus;
}

export interface DeskEntry {
  agent: AgentKind;
  sessionId: string;
  target: DeskTarget;
}

/** Where a message for a session can be delivered so the user will see it. */
export interface DeskRegistry {
  lookup(agent: AgentKind, sessionId: string): Promise<DeskTarget | null>;
  list(): Promise<DeskEntry[]>;
}

const AGENT_KINDS: readonly string[] = ['claude', 'opencode'];

/**
 * Whether a prompt can be submitted right now.
 *
 * `unknown` counts as injectable because tmux reports no status at all; treating
 * it as busy would refuse every tmux send. herdr reports a real status, so a
 * genuinely busy agent is caught there.
 */
export function isInjectable(status: HerdrStatus): boolean {
  return status === 'idle' || status === 'done' || status === 'unknown';
}

/**
 * herdr already maintains exactly this registry: `herdr agent list` publishes
 * session id, status and pane for both agent kinds, which is why this path
 * needs neither the Claude hooks nor any process/cwd guesswork.
 *
 * Resolution is always list-then-match: `herdr agent get <session_id>` answers
 * `agent_not_found`, because targeting is by pane id only.
 */
export class HerdrDeskRegistry implements DeskRegistry {
  constructor(private readonly cli: HerdrAgentCli = new HerdrAgentCli()) {}

  async lookup(agent: AgentKind, sessionId: string): Promise<DeskTarget | null> {
    const entry = (await this.list()).find(
      (e) => e.agent === agent && e.sessionId === sessionId,
    );
    return entry?.target ?? null;
  }

  async list(): Promise<DeskEntry[]> {
    const out: DeskEntry[] = [];
    for (const agent of await this.cli.list()) {
      if (!agent.sessionId) continue;
      if (!AGENT_KINDS.includes(agent.agent)) continue;
      out.push({
        agent: agent.agent as AgentKind,
        sessionId: agent.sessionId,
        target: { paneId: agent.paneId, mux: 'herdr', status: agent.status },
      });
    }
    return out;
  }
}

/**
 * The pre-herdr path: the Claude SessionStart hook records `TMUX_PANE`, so a
 * session started inside tmux carries its own pane.
 *
 * opencode is unreachable here on purpose. It has no hook, so a session could
 * only be matched to a pane through its project directory — ambiguous whenever
 * two opencode TUIs share a repository, which is common. Guessing wrong types a
 * message into somebody else's session.
 */
export class TmuxDeskRegistry implements DeskRegistry {
  constructor(private readonly liveSessions: () => LiveSession[] = () => readLiveSessions()) {}

  async lookup(agent: AgentKind, sessionId: string): Promise<DeskTarget | null> {
    if (agent !== 'claude') return null;
    const entry = this.liveSessions().find((e) => e.sessionId === sessionId);
    if (!entry?.paneId) return null;
    return { paneId: entry.paneId, mux: 'tmux', status: 'unknown' };
  }

  async list(): Promise<DeskEntry[]> {
    return this.liveSessions()
      .filter((e): e is LiveSession & { paneId: string } => typeof e.paneId === 'string')
      .map((e) => ({
        agent: 'claude' as const,
        sessionId: e.sessionId,
        target: { paneId: e.paneId, mux: 'tmux' as const, status: 'unknown' as const },
      }));
  }
}

/** Multiplexer 'none': nothing is reachable, so nothing is mirrored. */
export class EmptyDeskRegistry implements DeskRegistry {
  async lookup(): Promise<DeskTarget | null> { return null; }
  async list(): Promise<DeskEntry[]> { return []; }
}

export function deskRegistryFor(mux: Multiplexer): DeskRegistry {
  if (mux === 'herdr') return new HerdrDeskRegistry();
  if (mux === 'tmux') return new TmuxDeskRegistry();
  return new EmptyDeskRegistry();
}

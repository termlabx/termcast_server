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

/**
 * Every multiplexer at once, first match wins.
 *
 * A machine runs one multiplexer for the *phone's* terminals, but the user's
 * agents sit wherever they were started — this very machine runs herdr inside
 * tmux, so both hold live claude sessions. Asking only the configured one is
 * what made a tmux-hosted session look unreachable: the send found no target,
 * decided nothing held the session, and answered headlessly while the pane the
 * user was watching showed nothing.
 *
 * One registry failing (herdr's server down, say) must not hide the other's
 * sessions, so each is isolated.
 */
export class CompositeDeskRegistry implements DeskRegistry {
  constructor(private readonly registries: readonly DeskRegistry[]) {}

  async lookup(agent: AgentKind, sessionId: string): Promise<DeskTarget | null> {
    for (const registry of this.registries) {
      const target = await registry.lookup(agent, sessionId).catch(() => null);
      if (target) return target;
    }
    return null;
  }

  async list(): Promise<DeskEntry[]> {
    const seen = new Set<string>();
    const out: DeskEntry[] = [];
    for (const registry of this.registries) {
      for (const entry of await registry.list().catch((): DeskEntry[] => [])) {
        const key = `${entry.agent} ${entry.sessionId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
      }
    }
    return out;
  }
}

/** Single-multiplexer selection. Prefer defaultDeskRegistry outside tests. */
export function deskRegistryFor(mux: Multiplexer): DeskRegistry {
  if (mux === 'herdr') return new HerdrDeskRegistry();
  if (mux === 'tmux') return new TmuxDeskRegistry();
  return new EmptyDeskRegistry();
}

/**
 * What production uses. herdr comes first because it reports a real
 * `agent_status`, so when both know a session the one with a usable busy signal
 * wins. The configured multiplexer deliberately plays no part: it governs how
 * termcast spawns a phone's terminal, not where the user opened their agent.
 */
export function defaultDeskRegistry(): DeskRegistry {
  return new CompositeDeskRegistry([new HerdrDeskRegistry(), new TmuxDeskRegistry()]);
}

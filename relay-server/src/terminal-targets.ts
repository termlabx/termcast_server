import { exec, ExecException } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveMultiplexerBinary } from './ttyd-manager.js';

/**
 * The things a phone's "Raw Terminal" can attach to.
 *
 * A machine offers every terminal session it can actually reach: the tmux
 * sessions currently running, the herdr sessions (running or stopped), and a
 * plain interactive shell. The phone presents those as a picker; picking one
 * re-attaches its terminal to that exact session. `bash` is always offered so
 * there is always a working default even on a machine with no multiplexer.
 */
export type TerminalTargetKind = 'tmux' | 'herdr' | 'bash';

export interface TerminalTarget {
  kind: TerminalTargetKind;
  /** Stable key the phone echoes back when attaching. */
  id: string;
  /**
   * The session name handed to the multiplexer verbatim (never prefixed or
   * sanitised), or a human label for `bash`.
   */
  name: string;
}

/** Always available; the fallback for a machine with no multiplexer. */
export const BASH_TARGET: TerminalTarget = { kind: 'bash', id: 'bash', name: 'Plain shell' };

export type TargetRunner = (command: string) => Promise<{ stdout: string; code?: number }>;

/** Runs a command, never throwing — a missing/unusable binary yields empty output. */
const defaultRunner: TargetRunner = async (command) => {
  try {
    const { stdout } = await promisify(exec)(command);
    return { stdout, code: 0 };
  } catch (err) {
    const code = (err as ExecException).code;
    return { stdout: '', code: typeof code === 'number' ? code : 1 };
  }
};

/**
 * Pure parser for `tmux list-sessions -F '#{session_name}'` output: one name
 * per line. Blank lines are dropped; nothing else is assumed.
 */
export function parseTmuxSessions(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Pure parser for `herdr session list` output.
 *
 * The line layout is not a published contract, so parsing is deliberately
 * conservative: the first whitespace-separated token of each line is taken to
 * be the session name, and header/status lines that do not look like a name are
 * skipped. Session names recorded are the ones `herdr --session <name>` reuses.
 */
export function parseHerdrSessions(stdout: string): string[] {
  const HEADERS = new Set(['SESSION', 'NAME', 'ID', 'PID', 'STATUS', 'STATE']);
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.split(/\s+/)[0])
    .filter((name) => name && !HEADERS.has(name.toUpperCase()));
}

/** Command that lists the machine's tmux session names, or null when tmux is absent. */
function tmuxListCommand(bin: string): string {
  return `'${bin}' list-sessions -F '#{session_name}' 2>/dev/null`;
}

/** Command that lists the user's herdr sessions, or null when herdr is absent. */
function herdrListCommand(bin: string): string {
  return `'${bin}' session list 2>/dev/null`;
}

/**
 * Enumerate every terminal the phone can open, newest consideration first:
 * tmux sessions, then herdr sessions, then the plain Bash shell. A multiplexer
 * that is not installed on this machine contributes nothing.
 */
export async function listTerminalTargets(
  runner: TargetRunner = defaultRunner,
  bins: { tmux: string | null; herdr: string | null } = {
    tmux: resolveMultiplexerBinary('tmux'),
    herdr: resolveMultiplexerBinary('herdr'),
  },
): Promise<TerminalTarget[]> {
  const targets: TerminalTarget[] = [];

  if (bins.tmux) {
    const { stdout } = await runner(tmuxListCommand(bins.tmux));
    for (const name of parseTmuxSessions(stdout)) {
      targets.push({ kind: 'tmux', id: `tmux:${name}`, name });
    }
  }

  if (bins.herdr) {
    const { stdout } = await runner(herdrListCommand(bins.herdr));
    for (const name of parseHerdrSessions(stdout)) {
      targets.push({ kind: 'herdr', id: `herdr:${name}`, name });
    }
  }

  targets.push(BASH_TARGET);
  return targets;
}
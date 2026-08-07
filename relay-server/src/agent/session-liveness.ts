import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentKind } from './types.js';
import { readLiveSessions, type LiveSession } from './session-registry.js';

const execFileAsync = promisify(execFile);

/** Bounded: a slow `ps` must not hold up a session listing. */
const PS_TIMEOUT_MS = 5_000;
/** Process scans are cheap but not free, and a listing asks about many sessions. */
const PROCESS_CACHE_MS = 2_000;

export interface RunningProcess {
  pid: number;
  cwd: string;
  command: string;
}

export type ProcessLister = () => Promise<RunningProcess[]>;

export interface SessionLivenessOptions {
  liveSessions?: () => LiveSession[];
  processes?: ProcessLister;
}

/**
 * Whether anything on this machine is currently holding a session — a question
 * quite separate from whether we can *reach* it (see DeskRegistry).
 *
 * The distinction is load-bearing: "not reachable" must never be read as "not
 * running", or a `claude` sitting in Terminal.app would be offered for headless
 * resume and quietly fork a second agent against the same repository.
 */
export class SessionLiveness {
  private readonly liveSessions: () => LiveSession[];
  private readonly processes: ProcessLister;
  private cache: { at: number; value: RunningProcess[] } | null = null;

  constructor(opts: SessionLivenessOptions = {}) {
    this.liveSessions = opts.liveSessions ?? (() => readLiveSessions());
    this.processes = opts.processes ?? listProcesses;
  }

  async isAlive(agent: AgentKind, sessionId: string, projectPath: string): Promise<boolean> {
    if (agent === 'claude') {
      // The SessionStart hook records a pid per session and readLiveSessions
      // drops entries whose pid is gone, so this is exact — when the hooks are
      // installed. Without them every Claude session looks dead; `termcast
      // agent status` is what tells the user that.
      return this.liveSessions().some((entry) => entry.sessionId === sessionId);
    }

    // opencode has no hook mechanism and its API exposes no "a TUI holds this
    // session" signal, so liveness is directory-scoped: it answers "some
    // opencode holds this project", not "this session". Deliberately
    // conservative — it errs toward hiding a session rather than toward a
    // headless send behind a live TUI's back.
    if (!projectPath) return false;
    for (const proc of await this.snapshot()) {
      if (proc.cwd === projectPath && /(^|\/)opencode(\s|$)/.test(proc.command)) return true;
    }
    return false;
  }

  private async snapshot(): Promise<RunningProcess[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < PROCESS_CACHE_MS) return this.cache.value;
    let value: RunningProcess[] = [];
    try {
      value = await this.processes();
    } catch {
      // A failing scan reports "nothing running", which hides nothing and
      // permits a headless resume — the same behaviour as before this feature.
      value = [];
    }
    this.cache = { at: now, value };
    return value;
  }
}

/**
 * Every running `opencode`, with its working directory.
 *
 * `ps` cannot print a process's cwd, so the pids come from `pgrep` and each cwd
 * from `lsof -a -p <pid> -d cwd`. Both are POSIX-ish and present on macOS and
 * Linux; any failure degrades to an empty list.
 */
async function listProcesses(): Promise<RunningProcess[]> {
  const { stdout: pidList } = await execFileAsync('pgrep', ['-x', 'opencode'], { timeout: PS_TIMEOUT_MS });
  const pids = pidList.split('\n').map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
  if (pids.length === 0) return [];

  const out: RunningProcess[] = [];
  await Promise.all(pids.map(async (pid) => {
    try {
      const { stdout } = await execFileAsync(
        'lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
        { timeout: PS_TIMEOUT_MS },
      );
      // -Fn prints field-tagged lines; the cwd arrives as "n/path/to/dir".
      const cwd = stdout.split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? '';
      if (cwd) out.push({ pid, cwd, command: 'opencode' });
    } catch {
      // Process exited between pgrep and lsof, or lsof is unavailable.
    }
  }));
  return out;
}

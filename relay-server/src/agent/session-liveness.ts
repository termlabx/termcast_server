import { execFile } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
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
    this.processes = opts.processes ?? defaultProcessLister();
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

/** The `/proc` reads the Linux lister needs, as a test seam. */
export interface ProcFs {
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  readlink(path: string): Promise<string>;
}

const realProcFs: ProcFs = {
  readdir: (path) => readdir(path),
  readFile: (path) => readFile(path, 'utf8'),
  readlink: (path) => readlink(path),
};

/**
 * Pick the process lister for this platform.
 *
 * Linux gets `/proc`, not pgrep+lsof: lsof is absent from most server and
 * container images (Debian slim, Alpine), and the shell-out lister treats "no
 * lsof" as "nothing is running" — which offers a session a desk TUI is holding
 * for headless resume and forks a second agent behind it. Reading `/proc` needs
 * no external binary at all.
 */
export function defaultProcessLister(platform: string = process.platform): ProcessLister {
  return platform === 'linux' ? listProcProcesses : listPgrepProcesses;
}

/**
 * Every running `opencode`, with its working directory, read from `/proc`.
 *
 * `/proc/<pid>/comm` is the process name and `/proc/<pid>/cwd` a symlink to its
 * working directory. Anything unreadable is skipped rather than guessed at: a
 * pid can exit mid-scan, and another user's `cwd` link is EACCES.
 */
export async function listProcProcesses(fs: ProcFs = realProcFs): Promise<RunningProcess[]> {
  let entries: string[];
  try {
    entries = await fs.readdir('/proc');
  } catch {
    return [];
  }

  const pids = entries.map((e) => Number(e)).filter((n) => Number.isInteger(n) && n > 0);
  const out: RunningProcess[] = [];
  await Promise.all(pids.map(async (pid) => {
    try {
      // comm is truncated to 15 characters by the kernel; 'opencode' fits, and
      // matching it exactly mirrors what `pgrep -x opencode` finds on macOS.
      const comm = (await fs.readFile(`/proc/${pid}/comm`)).trim();
      if (comm !== 'opencode') return;
      const cwd = await fs.readlink(`/proc/${pid}/cwd`);
      if (cwd) out.push({ pid, cwd, command: 'opencode' });
    } catch {
      // Exited between readdir and here, or not ours to inspect.
    }
  }));
  return out.sort((a, b) => a.pid - b.pid);
}

/**
 * Every running `opencode`, with its working directory, via external tools.
 *
 * `ps` cannot print a process's cwd, so the pids come from `pgrep` and each cwd
 * from `lsof -a -p <pid> -d cwd`. Used on macOS, where both always exist; any
 * failure degrades to an empty list.
 */
export async function listPgrepProcesses(): Promise<RunningProcess[]> {
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

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OpencodeClient } from './opencode-client.js';

/** Ports an opencode server conventionally listens on before we spawn our own. */
const DEFAULT_CANDIDATES = ['http://127.0.0.1:4096'];
/** Port we spawn our own `opencode serve` on when none is already running. */
const SPAWN_PORT = 4097;
/** Readiness poll budget: 20 × 250 ms. */
const POLL_ROUNDS = 20;
const POLL_INTERVAL_MS = 250;

/**
 * Install locations the opencode installer writes to but a long-running
 * service's PATH often omits (notably ~/.opencode/bin). Checked before a PATH
 * search because the daemon usually inherits a minimal PATH.
 */
const BIN_CANDIDATES = [
  join(homedir(), '.opencode', 'bin', 'opencode'),
  join(homedir(), '.local', 'bin', 'opencode'),
  join(homedir(), '.npm-global', 'bin', 'opencode'),
  '/usr/local/bin/opencode',
  '/opt/homebrew/bin/opencode',
];

export interface ResolveOptions {
  override?: string;
  candidates?: string[];
}

export interface BinResolveOptions {
  candidates?: string[];
  pathEnv?: string;
}

/**
 * Locate the `opencode` executable, or null.
 *
 * The conventional install locations are tried first because a daemon spawned
 * by launchd/systemd typically inherits a PATH that omits them; a PATH search
 * is the fallback for installs elsewhere.
 */
export function resolveOpencodeBin(opts: BinResolveOptions = {}): string | null {
  for (const candidate of opts.candidates ?? BIN_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  for (const dir of (opts.pathEnv ?? process.env.PATH ?? '').split(':').filter(Boolean)) {
    const candidate = join(dir, 'opencode');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Find a usable opencode server, or null.
 *
 * Reusing a running server is preferred purely to avoid a second process —
 * correctness does not require it, since concurrent servers share storage and
 * see each other's sessions.
 */
export async function resolveOpencodeBaseUrl(opts: ResolveOptions = {}): Promise<string | null> {
  if (opts.override) return opts.override;
  for (const url of opts.candidates ?? DEFAULT_CANDIDATES) {
    if (await new OpencodeClient(url).health()) return url;
  }
  return null;
}

/**
 * Owns a spawned `opencode serve`, if we had to start one.
 *
 * Failure to start is never fatal: opencode simply contributes no sessions,
 * exactly as the tmux/herdr install paths degrade. Unlike the previous
 * behaviour, the failure is logged so a silently-missing agent is diagnosable.
 */
export class OpencodeServer {
  private child: ChildProcess | null = null;
  private url: string | null = null;

  async start(opts: ResolveOptions = {}): Promise<string | null> {
    const existing = await resolveOpencodeBaseUrl(opts);
    if (existing) {
      this.url = existing;
      console.log(`\x1b[32mopencode: using running server at ${existing}\x1b[0m`);
      return existing;
    }    const bin = resolveOpencodeBin();
    if (!bin) {
      console.warn(
        '\x1b[33mopencode: executable not found' +
        ` (searched ${BIN_CANDIDATES.join(', ')} and PATH); opencode sessions disabled.\x1b[0m`,
      );
      return null;
    }

    const port = SPAWN_PORT;
    // `dead` short-circuits the readiness poll. Without it, a server that fails
    // to start would stall termcastd's startup for the full poll budget.
    let dead = false;
    let ready = false;
    try {
      this.child = spawn(bin, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
        stdio: 'ignore',
        detached: false,
        // A daemon may carry a minimal environment; make sure the spawned
        // server sees the user's home so it reads the same session storage.
        env: { ...process.env, HOME: process.env.HOME ?? homedir() },
      });
      this.child.on('error', (err) => {
        dead = true;
        this.child = null;
        if (!ready) {
          console.warn(`\x1b[33mopencode: failed to start serve: ${err.message}; opencode sessions disabled.\x1b[0m`);
        }
      });
      this.child.on('exit', (code, signal) => {
        dead = true;
        if (!ready) {
          console.warn(
            `\x1b[33mopencode: spawned serve exited before becoming ready` +
            ` (${signal ? `signal ${signal}` : `exit code ${code}`}); opencode sessions disabled.\x1b[0m`,
          );
        }
      });
    } catch (err) {
      console.warn(`\x1b[33mopencode: failed to spawn serve: ${(err as Error).message}; opencode sessions disabled.\x1b[0m`);
      return null;
    }

    const candidate = `http://127.0.0.1:${port}`;
    const client = new OpencodeClient(candidate);
    for (let i = 0; i < POLL_ROUNDS && !dead; i++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (await client.health()) {
        ready = true;
        this.url = candidate;
        console.log(`\x1b[32mopencode: spawned server ready at ${candidate}\x1b[0m`);
        return candidate;
      }
    }
    this.stop();
    console.warn(
      `\x1b[33mopencode: spawned serve did not become ready within` +
      ` ${(POLL_ROUNDS * POLL_INTERVAL_MS) / 1000}s; opencode sessions disabled.\x1b[0m`,
    );
    return null;
  }

  /**
   * Returns a live base URL, (re)starting the server as needed.
   *
   * A cached URL is cheaply revalidated so a server that crashes later, or an
   * opencode install that appears after this process started, is recovered on
   * the next call rather than requiring a termcastd restart.
   */
  async ensureRunning(opts: ResolveOptions = {}): Promise<string | null> {
    if (this.url) {
      if (await new OpencodeClient(this.url).health()) return this.url;
      console.warn(`\x1b[33mopencode: server at ${this.url} is no longer healthy — re-resolving.\x1b[0m`);
      this.stop();
    }
    return this.start(opts);
  }

  baseUrl(): string | null {
    return this.url;
  }

  stop(): void {
    this.child?.kill('SIGTERM');
    this.child = null;
    this.url = null;
  }
}

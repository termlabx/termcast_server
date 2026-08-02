import { spawn, type ChildProcess } from 'node:child_process';
import { OpencodeClient } from './opencode-client.js';

/** Ports an opencode server conventionally listens on before we spawn our own. */
const DEFAULT_CANDIDATES = ['http://127.0.0.1:4096'];

export interface ResolveOptions {
  override?: string;
  candidates?: string[];
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
 * exactly as the tmux/herdr install paths degrade.
 */
export class OpencodeServer {
  private child: ChildProcess | null = null;
  private url: string | null = null;

  async start(opts: ResolveOptions = {}): Promise<string | null> {
    const existing = await resolveOpencodeBaseUrl(opts);
    if (existing) { this.url = existing; return existing; }

    const port = 4097;
    try {
      this.child = spawn('opencode', ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
        stdio: 'ignore',
        detached: false,
      });
      this.child.on('error', () => { this.child = null; });
    } catch {
      return null;
    }

    const candidate = `http://127.0.0.1:${port}`;
    const client = new OpencodeClient(candidate);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await client.health()) { this.url = candidate; return candidate; }
    }
    this.stop();
    return null;
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

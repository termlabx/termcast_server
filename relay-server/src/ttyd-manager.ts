import { spawn, ChildProcess, execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { homedir, hostname, platform, userInfo } from 'node:os';
import { ensureAugmentedIndex } from './ttyd-index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Tab title shown in the browser/window for the forwarded terminal, in the
 * form `os.hostname.username` (e.g. `macOS.MacBook-Pro.alice`). Replaces ttyd's
 * default title, which is the raw shell command (`/bin/zsh -c '...'`).
 */
function terminalTitle(): string {
  const p = platform();
  const os = p === 'darwin' ? 'macOS' : p === 'win32' ? 'Windows' : p === 'linux' ? 'Linux' : p;
  const host = hostname().split('.')[0]; // strip ".local"/domain suffix
  let user = 'user';
  try { user = userInfo().username; } catch {}
  return `${os}.${host}.${user}`;
}

/**
 * argv for ttyd so that a per-connection `?arg=<phoneId>` (enabled by ttyd's
 * `--url-arg`) lands in `$1` and selects/creates a per-phone tmux session
 * `tc_<sanitized phoneId>`. With no url-arg (browser/local view), `$1` is unset
 * and the session is `tc_shared`. The sanitisation MUST match
 * membership.ts `sessionNameFor`.
 */
export function buildTmuxShellArgs(shell: string, tmuxPath: string): string[] {
  // Sanitise with POSIX-portable `tr` rather than bash's `${s//pat/rep}`
  // expansion: `shell` is whatever $SHELL points to, which on Debian/Ubuntu
  // servers is /bin/sh (dash) — dash aborts the bashism with "Bad substitution",
  // killing the session before tmux ever runs. `tr -c 'A-Za-z0-9_' '_'` matches
  // membership.ts sessionNameFor() and works in dash, bash, and busybox ash.
  const script =
    's="${1:-shared}"; s="tc_$(printf %s "$s" | tr -c \'A-Za-z0-9_\' \'_\')"; ' +
    `exec '${tmuxPath}' new-session -A -s "$s"`;
  return [shell, '-c', script, 'termcast'];
}

export class TtydManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private orphanPid: number | null = null;
  private port: number;
  private shell: string;
  private tmux: boolean;
  private startedAt: number | null = null;
  private readonly pidFile = join(homedir(), '.termcast', 'termcastd.pid');
  // Legacy pidfile from before the ttyd→termcastd rename; still honoured when
  // adopting an orphan so upgrades don't leave a stray process behind.
  private readonly legacyPidFile = join(homedir(), '.termcast', 'ttyd.pid');

  constructor(options: { port?: number; shell?: string; tmux?: boolean } = {}) {
    super();
    this.port = options.port || 7681;
    this.shell = options.shell || process.env.SHELL || '/bin/bash';
    this.tmux = options.tmux !== false;
  }

  get wsURL(): string {
    return `ws://127.0.0.1:${this.port}/ws`;
  }

  /** pid of the ttyd child (or an adopted orphan), or null if not running. */
  get pid(): number | null {
    if (this.process?.pid != null && !this.process.killed) return this.process.pid;
    if (this.orphanPid !== null) return this.orphanPid;
    return null;
  }

  /** The port ttyd actually bound to (may differ from the requested port). */
  get currentPort(): number {
    return this.port;
  }

  /** Seconds ttyd has been running, or null if unknown / not running. */
  get uptimeSeconds(): number | null {
    if (!this.isRunning || this.startedAt === null) return null;
    return (Date.now() - this.startedAt) / 1000;
  }

  get isRunning(): boolean {
    if (this.orphanPid !== null) {
      if (this.isPidAlive(this.orphanPid)) return true;
      this.orphanPid = null;
    }
    return this.process !== null && !this.process.killed;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    // Adopt an orphaned ttyd left behind by a previous crash instead of spawning a new one
    const saved = this.readPidFile();
    if (saved && this.isPidAlive(saved.pid)) {
      console.log(`Adopting orphaned termcastd on port ${saved.port} (pid ${saved.pid})`);
      this.orphanPid = saved.pid;
      this.port = saved.port;
      this.startedAt = Date.now();
      this.emit('started', this.port);
      return;
    }
    this.removePidFile();

    // Find an available port, starting from the configured one
    const startPort = this.port;
    while (await this.isPortInUse(this.port)) {
      this.port++;
      if (this.port > startPort + 100) {
        console.error(`\x1b[31mError: No available port found (tried ${startPort}-${this.port - 1}).\x1b[0m`);
        process.exit(1);
      }
    }
    if (this.port !== startPort) {
      console.log(`Port ${startPort} in use, using ${this.port} instead`);
    }

    const ttydPath = this.findTtyd();

    // Verify ttyd can actually execute — catches missing dylib (e.g. libwebsockets-evlib_uv.dylib)
    let ttydVersion = 'unknown';
    try {
      ttydVersion = execSync(`"${ttydPath}" --version`, { encoding: 'utf-8', timeout: 5000 }).trim();
    } catch {
      console.error(`\x1b[31mError: termcastd failed to start. A required system library may be missing.\x1b[0m`);
      console.error(`  → Run: brew install libwebsockets`);
      console.error(`  → Or reinstall Termcast`);
      process.exit(1);
    }

    // Check if shell exists
    if (!existsSync(this.shell)) {
      console.error(`\x1b[31mError: Shell not found: ${this.shell}\x1b[0m`);
      console.error(`  → Install it or specify a different shell: termcast start --shell /bin/sh`);
      process.exit(1);
    }

    let tmuxPath: string | null = null;
    if (this.tmux) {
      tmuxPath = await this.findOrInstallTmux();
      if (!tmuxPath) {
        console.log('tmux not available — starting shell without tmux');
      }
    }

    const shellArgs = tmuxPath
      ? buildTmuxShellArgs(this.shell, tmuxPath)
      : [this.shell];

    // Serve an augmented client (ttyd's own client plus our injected clipboard
    // script) so the browser view gets mouse-select-to-copy and Ctrl/Cmd+V
    // paste against the local OS clipboard. Best-effort: on failure we fall back
    // to ttyd's stock client rather than refusing to start.
    const augmentedIndex = await ensureAugmentedIndex(ttydPath, ttydVersion);
    const indexArgs = augmentedIndex ? ['-I', augmentedIndex] : [];

    this.process = spawn(ttydPath, [
      '--port', String(this.port),
      '--interface', '127.0.0.1',
      '--writable',
      '-a',
      '-t', 'unicodeVersion=11',
      '-t', `titleFixed=${terminalTitle()}`,
      ...indexArgs,
      ...shellArgs,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Ensure UTF-8 locale so the shell and programs (e.g. Claude Code)
        // output full Unicode rather than ASCII-only fallback characters.
        LANG: process.env.LANG || 'en_US.UTF-8',
        LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
        // Signal that the terminal supports 24-bit colour and Unicode art.
        COLORTERM: process.env.COLORTERM || 'truecolor',
        TERM: process.env.TERM || 'xterm-256color',
      },
    });

    this.process.stdout?.on('data', (data: Buffer) => {
      this.emit('log', data.toString());
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString();
      // Detect common ttyd errors and provide guidance
      if (msg.includes('bindfd') || msg.includes('binding') || msg.includes('Address already in use')) {
        console.error(`\x1b[31mError: termcastd failed to bind to port ${this.port}.\x1b[0m`);
        console.error(`  → Kill existing process:  lsof -ti:${this.port} | xargs kill`);
        console.error(`  → Or use another port:    termcast start --port <other-port>`);
      }
      this.emit('log', msg);
    });

    this.process.on('exit', (code, signal) => {
      this.removePidFile();
      this.process = null;
      this.startedAt = null;
      if (signal) {
        console.error(`\x1b[31mtermcastd killed by signal ${signal}.\x1b[0m`);
        console.error(`  → If this is a library loading error, ensure termcastd is statically linked or libraries are codesigned.`);
      } else if (code !== null && code !== 0) {
        console.error(`\x1b[31mtermcastd exited with code ${code}.\x1b[0m`);
        if (code === 127) {
          console.error(`  → termcastd binary not found. Reinstall Termcast: npm install -g @termcast/cli`);
        }
      }
      this.emit('exit', code, signal);
    });

    if (this.process.pid) {
      this.writePidFile(this.process.pid, this.port);
    }

    this.startedAt = Date.now();
    this.emit('started', this.port);
  }

  stop(): void {
    if (this.orphanPid !== null) {
      const pid = this.orphanPid;
      this.orphanPid = null;
      try { process.kill(pid, 'SIGTERM'); } catch {}
      setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch {} }, 5000);
      this.removePidFile();
      return;
    }
    if (!this.process) return;
    const proc = this.process;
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGKILL');
      }
    }, 5000);
  }

  private isPidAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  private writePidFile(pid: number, port: number): void {
    try {
      mkdirSync(join(homedir(), '.termcast'), { recursive: true });
      writeFileSync(this.pidFile, JSON.stringify({ pid, port }));
    } catch {}
  }

  private removePidFile(): void {
    try { unlinkSync(this.pidFile); } catch {}
    try { unlinkSync(this.legacyPidFile); } catch {}
  }

  private readPidFile(): { pid: number; port: number } | null {
    for (const p of [this.pidFile, this.legacyPidFile]) {
      try { return JSON.parse(readFileSync(p, 'utf-8')); } catch {}
    }
    return null;
  }

  private isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection({ port, host: '127.0.0.1' });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
      socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
    });
  }

  private async findOrInstallTmux(): Promise<string | null> {
    const binaryName = `tmux-${process.platform}-${process.arch}`;
    try {
      // 1. Bundled binary (shipped with the app)
      const bundledPaths = [
        join(__dirname, '..', 'bin', binaryName),
        join(__dirname, '..', 'bin', 'tmux'),
        join(__dirname, '..', '..', 'bin', binaryName),
        join(__dirname, '..', '..', 'bin', 'tmux'),
      ];
      for (const p of bundledPaths) {
        if (existsSync(p)) return p;
      }

      // 2. Previously downloaded binary
      const downloadDir = join(homedir(), '.termcast', 'bin');
      const downloadedPath = join(downloadDir, binaryName);
      if (existsSync(downloadedPath)) return downloadedPath;

      // 3. System tmux
      try {
        const systemPath = execSync('which tmux', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (systemPath) return systemPath;
      } catch {}

      // 4. Download lazily — failure here must not crash the server
      const url = `https://relay.example.com/releases/${binaryName}`;
      console.log(`tmux not found — downloading for ${process.platform}-${process.arch}...`);
      mkdirSync(downloadDir, { recursive: true });
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      writeFileSync(downloadedPath, Buffer.from(await resp.arrayBuffer()), { mode: 0o755 });
      console.log('tmux ready');
      return downloadedPath;
    } catch (err) {
      console.log(`tmux unavailable (${(err as Error).message}) — using bash fallback`);
      try { unlinkSync(join(homedir(), '.termcast', 'bin', binaryName)); } catch {}
      return null;
    }
  }

  private findTtyd(): string {
    const arch = `${process.platform}-${process.arch}`;
    // Prefer the rebranded `termcastd` binary (what the npm postinstall and the
    // installers ship today); fall back to the legacy `ttyd` name so servers
    // installed before the rename keep working until they re-download.
    const bundledPaths = [
      join(__dirname, '..', 'bin', `termcastd-${arch}`),
      join(__dirname, '..', 'bin', 'termcastd'),
      join(__dirname, '..', '..', 'bin', `termcastd-${arch}`),
      join(__dirname, '..', '..', 'bin', 'termcastd'),
      join(__dirname, '..', 'bin', `ttyd-${arch}`),
      join(__dirname, '..', 'bin', 'ttyd'),
      join(__dirname, '..', '..', 'bin', `ttyd-${arch}`),
      join(__dirname, '..', '..', 'bin', 'ttyd'),
    ];
    for (const p of bundledPaths) {
      if (existsSync(p)) return p;
    }

    // Check PATH (termcastd first, then legacy ttyd)
    for (const name of ['termcastd', 'ttyd']) {
      try {
        execSync(`which ${name}`, { stdio: 'ignore' });
        return name;
      } catch {}
    }

    console.error(`\x1b[31mError: termcastd binary not found.\x1b[0m`);
    console.error(`Searched:`);
    for (const p of bundledPaths) {
      console.error(`  - ${p}`);
    }
    console.error(`  - PATH (system)`);
    console.error(`\nReinstall Termcast: npm install -g @termcast/cli`);
    process.exit(1);
  }
}

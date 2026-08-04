import { spawn, ChildProcess, execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { homedir, hostname, platform, userInfo } from 'node:os';
import { ensureAugmentedIndex } from './ttyd-index.js';
import { Multiplexer } from './multiplexer.js';
import { downloadHerdr, herdrAssetName } from './herdr-install.js';
import { resolveBaseUrl, releaseUrl } from './upgrade.js';

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
 * argv for ttyd so that per-connection `?arg=` values (enabled by ttyd's
 * `--url-arg`) select the session, the multiplexer, and attach mode:
 * `$1` is the session token, `$2` is `tmux` | `herdr` | `none`, and `@arg 3`
 * (`a`) is `1` when the token is an exact session name to attach rather than a
 * phone id to prefix.
 *
 * Two modes:
 *   - Default (phones / legacy): `$1` is the phone id and is sanitised and
 *     prefixed into this app's private `tc_`/`tch_` namespace.
 *   - Attach: `$1` is an existing session name taken verbatim — tmux and herdr
 *     both attach-or-create with the given name, so the prefix must be dropped
 *     and the name must NOT be run through the `tr` sanitiser (tmux session
 *     names commonly contain `.` and `-`).
 *
 * With no url-args (browser/local view), `$1` is `shared` and `$2` comes from
 * the sidecar file. Phones always send `$2` (bridge.ts). Everything else falls
 * back to the sidecar, which is rewritten whenever the setting changes — so a
 * switch applies without respawning ttyd and without dropping connections.
 *
 * The script MUST stay POSIX-portable. `shell` is whatever $SHELL points to,
 * which on Debian/Ubuntu servers is /bin/sh (dash) — dash aborts bashisms like
 * `${s//pat/rep}` with "Bad substitution", killing the session before the
 * multiplexer ever runs. `tr -c 'A-Za-z0-9_' '_'` works in dash, bash, and
 * busybox ash. Same reason there is no JSON parsing here: the setting lives in
 * a one-word sidecar file rather than config.json.
 *
 * The `tc_`/`tch_` prefixes and the sanitisation MUST match multiplexer.ts
 * `sessionNameFor()`.
 */
export function buildMultiplexerShellArgs(opts: {
  shell: string;
  tmuxPath: string | null;
  herdrPath: string | null;
  sidecarPath: string;
  fallback: Multiplexer;
}): string[] {
  const { shell, tmuxPath, herdrPath, sidecarPath, fallback } = opts;

  // Only resolved binaries get a branch; anything unresolved falls through to
  // the default, which degrades to a bare shell when tmux is missing too.
  const branches: string[] = [];
  if (herdrPath) branches.push(`  herdr:1) exec '${herdrPath}' --session "$sname" ;;`);
  if (herdrPath) branches.push(`  herdr:*) exec '${herdrPath}' --session "tch_$sname" ;;`);
  branches.push(`  none:*) exec '${shell}' ;;`);
  branches.push(tmuxPath
    ? `  *:1) exec '${tmuxPath}' new-session -A -s "$sname" ;;`
    : `  *:1) exec '${shell}' ;;`);
  branches.push(tmuxPath
    ? `  *) exec '${tmuxPath}' new-session -A -s "tc_$sname" ;;`
    : `  *) exec '${shell}' ;;`);

  const script = [
    `s="\${1:-shared}"; m="\${2:-$(cat '${sidecarPath}' 2>/dev/null || echo ${fallback})}"; a="\${3:-}"`,
    `if [ "$a" = "1" ]; then sname="$s"; else sname="$(printf %s "$s" | tr -c 'A-Za-z0-9_' '_')"; fi`,
    'case "$m:$a" in',
    ...branches,
    'esac',
  ].join('\n');

  return [shell, '-c', script, 'termcast'];
}

/**
 * Stable fingerprint of the shell args we would spawn, so start() can tell an
 * orphaned termcastd that was born from the *current* wrapper script from one
 * left over by an older build. A salt-free FNV-1a over the full argv is enough:
 * identical binaries and shell yield identical output, and any difference (a
 * newly installed multiplexer, our attach-mode work, a shell change) flips it.
 */
export function wrapperSignature(shellArgs: string[]): string {
  let h = 2166136261; // FNV offset basis
  for (const part of shellArgs) {
    for (let i = 0; i < part.length; i++) {
      h ^= part.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h = Math.imul(h ^ 0x1e3, 16777619);
  }
  return (h >>> 0).toString(16);
}

/**
 * Variables a multiplexer sets inside its own panes to mark "you are already
 * inside me". Both multiplexers refuse to nest when they see these, so they
 * MUST NOT reach the ttyd child.
 *
 * This bites whenever the server is started from inside a multiplexer — running
 * `termcast start` from a herdr pane or a tmux window is entirely normal, and
 * without this every connection dies on spawn: herdr exits 1 with "nested herdr
 * is disabled by default", tmux with "sessions should be nested with care".
 * The session we launch is a sibling of the caller's, never a child, so
 * dropping these is always correct.
 */
export function stripNestingEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    // herdr: HERDR_ENV, HERDR_PANE_ID, HERDR_SOCKET_PATH, HERDR_TAB_ID,
    // HERDR_WORKSPACE_ID, HERDR_STARTUP_CWD (verified against v0.7.5).
    // tmux: TMUX, TMUX_PANE.
    if (key.startsWith('HERDR_') || key === 'TMUX' || key === 'TMUX_PANE') {
      delete out[key];
    }
  }
  return out;
}

/**
 * Where an already-present binary might live, in the order start() prefers:
 * bundled with the app, previously downloaded, then system PATH. Download-free,
 * so the settings UI can report installed state without side effects. MUST stay
 * in step with findOrInstallTmux()/findOrInstallHerdr() or the UI will claim
 * something is missing that the wrapper script happily execs.
 */
export function resolveMultiplexerBinary(mux: 'tmux' | 'herdr'): string | null {
  const names = mux === 'tmux'
    ? [`tmux-${process.platform}-${process.arch}`, 'tmux']
    : ['herdr'];
  for (const name of names) {
    for (const p of [
      join(__dirname, '..', 'bin', name),
      join(__dirname, '..', '..', 'bin', name),
      join(homedir(), '.termcast', 'bin', name),
      // The `curl | sh` installer for herdr (and several brew tap flows) drops
      // the binary in ~/.local/bin, which is frequently NOT on the PATH the
      // desktop app/relay process inherits. Resolving it here keeps the
      // terminal picker working even when `which herdr` fails.
      join(homedir(), '.local', 'bin', name),
    ]) {
      if (existsSync(p)) return p;
    }
  }
  try {
    const systemPath = execSync(`which ${mux}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (systemPath) return systemPath;
  } catch {}
  return null;
}

/**
 * Fetch the tmux binary for this platform into ~/.termcast/bin. Used by the
 * explicit "Install" action in the settings UI and CLI; start() has its own
 * lazy path. Throws on failure — the caller reports it and keeps the current
 * multiplexer.
 */
export async function downloadTmux(): Promise<string> {
  const binaryName = `tmux-${process.platform}-${process.arch}`;
  const downloadDir = join(homedir(), '.termcast', 'bin');
  const destPath = join(downloadDir, binaryName);
  const resp = await fetch(releaseUrl(resolveBaseUrl(), binaryName));
  if (!resp.ok) throw new Error(`tmux download failed: HTTP ${resp.status}`);
  mkdirSync(downloadDir, { recursive: true });
  writeFileSync(destPath, Buffer.from(await resp.arrayBuffer()), { mode: 0o755 });
  return destPath;
}

/** What the settings page and `termcast multiplexer` report as installed. */
export function detectInstalledMultiplexers(): { tmux: boolean; herdr: boolean } {
  return {
    tmux: resolveMultiplexerBinary('tmux') !== null,
    herdr: resolveMultiplexerBinary('herdr') !== null,
  };
}

export class TtydManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private orphanPid: number | null = null;
  private port: number;
  private shell: string;
  private multiplexer: Multiplexer;
  private startedAt: number | null = null;
  private readonly pidFile = join(homedir(), '.termcast', 'termcastd.pid');
  // Legacy pidfile from before the ttyd→termcastd rename; still honoured when
  // adopting an orphan so upgrades don't leave a stray process behind.
  private readonly legacyPidFile = join(homedir(), '.termcast', 'ttyd.pid');

  constructor(options: { port?: number; shell?: string; multiplexer?: Multiplexer } = {}) {
    super();
    this.port = options.port || 7681;
    this.shell = options.shell || process.env.SHELL || '/bin/bash';
    this.multiplexer = options.multiplexer ?? 'tmux';
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

    // Resolve BOTH multiplexers regardless of which is currently selected: the
    // wrapper script dispatches per connection, so a later switch must not need
    // a respawn. `none` skips resolution entirely.
    let tmuxPath: string | null = null;
    let herdrPath: string | null = null;
    if (this.multiplexer !== 'none') {
      tmuxPath = await this.findOrInstallTmux();
      herdrPath = await this.findOrInstallHerdr();
      if (!tmuxPath && !herdrPath) {
        console.log('no multiplexer available — starting a plain shell');
      }
    }

    const shellArgs = buildMultiplexerShellArgs({
      shell: this.shell,
      tmuxPath,
      herdrPath,
      sidecarPath: join(homedir(), '.ttyd-server', 'multiplexer'),
      fallback: this.multiplexer,
    });
    const signature = wrapperSignature(shellArgs);

    // Adopt an orphaned ttyd left behind by a previous crash instead of
    // spawning a new one — but ONLY when it was born from the exact wrapper we
    // would spawn now. An orphan from an older build (before the attach /
    // terminal-picker work, or one that started before a multiplexer was
    // installed) keeps its old argv forever: it would answer every phone with
    // /bin/zsh — including a phone that asked to attach to a tmux session. A
    // signature mismatch respawns instead, which also self-heals upgrades.
    const saved = this.readPidFile();
    const orphan = saved && this.isPidAlive(saved.pid) ? saved : null;
    if (orphan) {
      if (orphan.signature === signature) {
        console.log(`Adopting orphaned termcastd on port ${orphan.port} (pid ${orphan.pid})`);
        this.orphanPid = orphan.pid;
        this.port = orphan.port;
        this.startedAt = Date.now();
        this.emit('started', this.port);
        return;
      }
      console.log(`Orphaned termcastd on port ${orphan.port} (pid ${orphan.pid}) has an outdated wrapper — respawning it`);
      try { process.kill(orphan.pid, 'SIGTERM'); } catch {}
      // Give the dying orphan a moment to release its port so we can reuse it.
      for (let i = 0; i < 30 && await this.isPortInUse(orphan.port); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
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
        ...stripNestingEnv(process.env),
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
      this.writePidFile(this.process.pid, this.port, signature);
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

  private writePidFile(pid: number, port: number, signature: string): void {
    try {
      mkdirSync(join(homedir(), '.termcast'), { recursive: true });
      writeFileSync(this.pidFile, JSON.stringify({ pid, port, signature }));
    } catch {}
  }

  private removePidFile(): void {
    try { unlinkSync(this.pidFile); } catch {}
    try { unlinkSync(this.legacyPidFile); } catch {}
  }

  private readPidFile(): { pid: number; port: number; signature?: string } | null {
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

      // 3. Home-local binary (~/.local/bin), mirroring resolveMultiplexerBinary
      for (const p of [join(homedir(), '.local', 'bin', 'tmux')]) {
        if (existsSync(p)) return p;
      }

      // 4. System tmux
      try {
        const systemPath = execSync('which tmux', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (systemPath) return systemPath;
      } catch {}

      // 5. Download lazily — failure here must not crash the server
      const url = releaseUrl(resolveBaseUrl(), binaryName);
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

  /**
   * Resolve herdr, downloading it only when it is the selected multiplexer.
   *
   * Unlike tmux we do NOT download speculatively: the binary is ~17MB and a
   * tmux user would never run it. An already-present herdr is always resolved
   * though, so switching to it later needs no respawn.
   *
   * Failure is never fatal — the wrapper script simply gets no herdr branch.
   */
  private async findOrInstallHerdr(): Promise<string | null> {
    const binaryName = herdrAssetName(process.platform, process.arch);
    const downloadDir = join(homedir(), '.termcast', 'bin');
    const downloadedPath = join(downloadDir, 'herdr');

    try {
      // 1. Bundled binary (shipped with the app)
      for (const p of [
        join(__dirname, '..', 'bin', 'herdr'),
        join(__dirname, '..', '..', 'bin', 'herdr'),
      ]) {
        if (existsSync(p)) return p;
      }

      // 2. Previously downloaded binary
      if (existsSync(downloadedPath)) return downloadedPath;

      // 3. System herdr (brew / curl install) — also ~/.local/bin, which the
      //    curl installer uses but which is often absent from the server PATH.
      for (const p of [join(homedir(), '.local', 'bin', 'herdr')]) {
        if (existsSync(p)) return p;
      }
      try {
        const systemPath = execSync('which herdr', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (systemPath) return systemPath;
      } catch {}

      // 4. Download — only when the user actually selected herdr.
      if (this.multiplexer !== 'herdr') return null;
      if (!binaryName) {
        console.log(`herdr has no build for ${process.platform}-${process.arch}`);
        return null;
      }
      console.log(`herdr not found — downloading for ${process.platform}-${process.arch}...`);
      await downloadHerdr(downloadedPath);
      console.log('herdr ready');
      return downloadedPath;
    } catch (err) {
      console.log(`herdr unavailable (${(err as Error).message})`);
      // A partial or unverified download must not linger and be trusted next start.
      try { unlinkSync(downloadedPath); } catch {}
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

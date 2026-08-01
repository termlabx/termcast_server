import { spawn, ChildProcess, execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { homedir, hostname, platform, userInfo } from 'node:os';
import { resolveBaseUrl, releaseUrl } from './upgrade.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Tab title shown in the browser/window for the forwarded terminal, in the
 * form `os.hostname.username` (e.g. `macOS.MacBook-Pro.alice`). Replaces
 * termcastd's default title, which is the raw shell command (`/bin/zsh -c '...'`).
 */
function terminalTitle(): string {
  const p = platform();
  const os = p === 'darwin' ? 'macOS' : p === 'win32' ? 'Windows' : p === 'linux' ? 'Linux' : p;
  const host = hostname().split('.')[0]; // strip ".local"/domain suffix
  let user = 'user';
  try { user = userInfo().username; } catch {}
  return `${os}.${host}.${user}`;
}

export class TermcastdManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private port: number;
  private shell: string;
  private tmux: boolean;

  constructor(options: { port?: number; shell?: string; tmux?: boolean } = {}) {
    super();
    this.port = options.port || 7681;
    this.shell = options.shell || process.env.SHELL || '/bin/bash';
    this.tmux = options.tmux !== false;
  }

  get wsURL(): string {
    return `ws://127.0.0.1:${this.port}/ws`;
  }

  get isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

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

    const termcastdPath = this.findTermcastd();

    // Check if shell exists
    if (!existsSync(this.shell)) {
      console.error(`\x1b[31mError: Shell not found: ${this.shell}\x1b[0m`);
      console.error(`  → Install it or specify a different shell: termcastd-server start --shell /bin/sh`);
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
      ? [this.shell, '-c', `'${tmuxPath}' a 2>/dev/null || '${tmuxPath}'`]
      : [this.shell];
    this.process = spawn(termcastdPath, [
      '--port', String(this.port),
      '--interface', '127.0.0.1',
      '--writable',
      '-t', 'unicodeVersion=11',
      '-t', `titleFixed=${terminalTitle()}`,
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
      // Detect common termcastd errors and provide guidance
      if (msg.includes('bindfd') || msg.includes('binding') || msg.includes('Address already in use')) {
        console.error(`\x1b[31mError: termcastd failed to bind to port ${this.port}.\x1b[0m`);
        console.error(`  → Kill existing process:  lsof -ti:${this.port} | xargs kill`);
        console.error(`  → Or use another port:    termcastd-server start --port <other-port>`);
      }
      this.emit('log', msg);
    });

    this.process.on('exit', (code, signal) => {
      this.process = null;
      if (signal) {
        console.error(`\x1b[31mtermcastd killed by signal ${signal}.\x1b[0m`);
        console.error(`  → If this is a library loading error, ensure termcastd is statically linked or libraries are codesigned.`);
      } else if (code !== null && code !== 0) {
        console.error(`\x1b[31mtermcastd exited with code ${code}.\x1b[0m`);
        if (code === 127) {
          console.error(`  → termcastd binary not found. Install it or place it in the bin/ directory.`);
        }
      }
      this.emit('exit', code, signal);
    });

    this.emit('started', this.port);
  }

  stop(): void {
    if (!this.process) return;
    const proc = this.process;
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGKILL');
      }
    }, 5000);
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

  private findTermcastd(): string {
    const bundledPaths = [
      join(__dirname, '..', 'bin', `termcastd-${process.platform}-${process.arch}`),
      join(__dirname, '..', 'bin', 'termcastd'),
      join(__dirname, '..', '..', 'bin', `termcastd-${process.platform}-${process.arch}`),
      join(__dirname, '..', '..', 'bin', 'termcastd'),
    ];
    for (const p of bundledPaths) {
      if (existsSync(p)) return p;
    }

    // Check PATH
    try {
      execSync('which termcastd', { stdio: 'ignore' });
      return 'termcastd';
    } catch {
      // Also check for termcastd in PATH as fallback for developers
      try {
        execSync('which termcastd', { stdio: 'ignore' });
        return 'termcastd';
      } catch {
        console.error(`\x1b[31mError: termcastd binary not found.\x1b[0m`);
        console.error(`Searched:`);
        for (const p of bundledPaths) {
          console.error(`  - ${p}`);
        }
        console.error(`  - PATH (system)`);
        console.error(`\nInstall termcastd or termcastd.`);
        process.exit(1);
      }
    }
  }
}

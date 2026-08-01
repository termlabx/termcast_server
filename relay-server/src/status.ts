// Shared status snapshot shape + a pure formatter.
//
// The running `start` process holds all of this live state. It exposes a
// snapshot over the Web UI's HTTP server (GET /api/status); the `status`
// command fetches it and renders with `formatStatus`. Keeping the formatter
// pure (string in, string out) makes it unit-testable without a live server.

export interface ClientStatus {
  id: number;
  ip?: string;
  location?: string;
  device?: string;
  paired: boolean;
  /** epoch ms when this client connected */
  connectedAt: number;
  /** deviceId a meshing-in server authenticated as; joins to a saved mesh peer */
  peerDeviceId?: string;
}

export interface StatusSnapshot {
  version: string;
  /** pid of the node `start` process (the server itself) */
  serverPid: number;
  /** seconds the server process has been up */
  uptimeSeconds: number;
  relay: {
    url: string;
    connected: boolean;
  };
  ttyd: {
    pid: number | null;
    port: number;
    running: boolean;
    /** seconds the ttyd child has been up, or null if unknown */
    uptimeSeconds: number | null;
  };
  clients: ClientStatus[];
  cloudflare: {
    /** HTTP fetches to the relay Worker (register, etc.) */
    httpRequests: number;
    /** relay WebSocket (re)connections */
    wsConnects: number;
    /** frames sent up the relay WebSocket (pings + terminal data) */
    wsMessagesSent: number;
    total: number;
  };
  mesh: {
    name: string;
    port: number;
    forwards?: { remotePort: number; localPort: number; state: string; message?: string }[];
  }[];
}

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

/** Human-friendly duration, e.g. 90 -> "1m 30s", 3700 -> "1h 1m". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function describeClient(c: ClientStatus): string {
  const bits: string[] = [];
  if (c.ip) bits.push(c.ip);
  if (c.location) bits.push(c.location);
  if (c.device) bits.push(c.device);
  const label = bits.length ? bits.join(' · ') : 'unknown client';
  const lock = c.paired ? '🔒' : '…';
  return `${lock} ${label} ${C.dim}(up ${formatDuration((Date.now() - c.connectedAt) / 1000)})${C.reset}`;
}

export interface FormatOptions {
  /** Emit ANSI colour codes. Defaults to true. */
  color?: boolean;
}

/** Render a status snapshot for the terminal. */
export function formatStatus(s: StatusSnapshot, opts: FormatOptions = {}): string {
  const color = opts.color !== false;
  const paint = (code: string, text: string) => (color ? `${code}${text}${C.reset}` : text);

  const lines: string[] = [];
  lines.push(paint(C.bold + C.green, `● Termcast running`) +
    paint(C.dim, `  v${s.version}  ·  up ${formatDuration(s.uptimeSeconds)}  ·  pid ${s.serverPid}`));

  // Relay
  const relayState = s.relay.connected
    ? paint(C.green, 'connected')
    : paint(C.yellow, 'disconnected');
  lines.push('');
  lines.push(paint(C.bold, 'Relay'));
  lines.push(`  status   ${relayState}`);
  lines.push(`  url      ${paint(C.dim, s.relay.url)}`);

  // termcastd
  lines.push('');
  lines.push(paint(C.bold, 'termcastd'));
  if (s.ttyd.running) {
    const up = s.ttyd.uptimeSeconds != null ? `  ·  up ${formatDuration(s.ttyd.uptimeSeconds)}` : '';
    lines.push(`  status   ${paint(C.green, 'running')}${paint(C.dim, up)}`);
    lines.push(`  pid      ${s.ttyd.pid ?? '?'}`);
    lines.push(`  port     ${s.ttyd.port}`);
  } else {
    lines.push(`  status   ${paint(C.yellow, 'not running')}`);
  }

  // Clients
  lines.push('');
  lines.push(paint(C.bold, `Clients`) + paint(C.dim, ` (${s.clients.length} connected)`));
  if (s.clients.length === 0) {
    lines.push(paint(C.dim, '  none'));
  } else {
    for (const c of s.clients) {
      lines.push(`  [${c.id}] ${color ? describeClient(c) : describeClientPlain(c)}`);
    }
  }

  // Mesh peers
  if (s.mesh.length > 0) {
    lines.push('');
    lines.push(paint(C.bold, 'Mesh peers'));
    for (const p of s.mesh) {
      lines.push(`  ${p.name} ${paint(C.dim, `→ localhost:${p.port}`)}`);
      for (const f of p.forwards ?? []) {
        const state = f.state === 'active' ? paint(C.green, 'active')
          : f.state === 'error' ? paint(C.yellow, `error${f.message ? ': ' + f.message : ''}`)
          : paint(C.dim, f.state);
        lines.push(`    localhost:${f.localPort} → :${f.remotePort}  ${state}`);
      }
    }
  }

  // Cloudflare usage
  lines.push('');
  lines.push(paint(C.bold, 'Cloudflare relay requests') + paint(C.dim, ' (this session)'));
  lines.push(`  total            ${paint(C.cyan, String(s.cloudflare.total))}`);
  lines.push(`  ├─ http          ${s.cloudflare.httpRequests}`);
  lines.push(`  ├─ ws connects   ${s.cloudflare.wsConnects}`);
  lines.push(`  └─ ws messages   ${s.cloudflare.wsMessagesSent}`);

  return lines.join('\n');
}

function describeClientPlain(c: ClientStatus): string {
  const bits: string[] = [];
  if (c.ip) bits.push(c.ip);
  if (c.location) bits.push(c.location);
  if (c.device) bits.push(c.device);
  const label = bits.length ? bits.join(' · ') : 'unknown client';
  const lock = c.paired ? '[paired]' : '[pairing]';
  return `${lock} ${label} (up ${formatDuration((Date.now() - c.connectedAt) / 1000)})`;
}

// Pure tray-menu label formatting — kept free of Electron imports so it can
// be unit-tested with node:test.

import type { TrayStatus } from './tray-status';

/** Hover text for the tray icon. The device count only means anything once the
 *  relay is up, so the other states say what's actually happening instead. */
export function trayTooltip(status: TrayStatus, deviceCount: number): string {
  if (status === 'connecting') return 'Termcast — connecting...';
  if (status === 'offline') return 'Termcast — not connected';
  if (deviceCount === 0) return 'Termcast — ready for connections';
  return `Termcast — ${deviceCount} device${deviceCount === 1 ? '' : 's'} connected`;
}

/** One forward's runtime state, as served by GET /api/mesh. */
export interface ForwardState {
  remotePort: number;
  localPort: number;
  state: string; // 'pending' | 'active' | 'error'
  message?: string;
}

export function forwardLabel(f: ForwardState): string {
  const icon = f.state === 'active' ? '🟢' : f.state === 'error' ? '🔴' : '⏳';
  const suffix = f.state === 'error' && f.message ? ` — ${f.message}` : '';
  return `localhost:${f.localPort} → :${f.remotePort} · ${icon} ${f.state}${suffix}`;
}

const DEVICE_TOKENS = ['Server', 'iPhone', 'iPad', 'Android', 'Mac', 'Windows', 'Linux'];

interface ClientInfoParts { ip?: string; location?: string; device?: string; }

/** Content-aware parse of the server's "ip | location | device" info string,
 *  where any of the three may be absent. */
function parseClientInfo(info: string | null): ClientInfoParts {
  if (!info) return {};
  const segs = info.split(' | ').map(s => s.trim()).filter(s => s.length > 0);
  const parts: ClientInfoParts = {};
  // device = last segment iff it is a known device token
  if (segs.length > 0 && DEVICE_TOKENS.includes(segs[segs.length - 1])) {
    parts.device = segs.pop();
  }
  // ip = first segment iff it looks like an IPv4 dotted-quad or an IPv6 (has ':')
  if (segs.length > 0 && (/^\d{1,3}(\.\d{1,3}){3}$/.test(segs[0]) || segs[0].includes(':'))) {
    parts.ip = segs.shift();
  }
  // remainder (if any) is the location
  if (segs.length > 0) parts.location = segs.join(' | ');
  return parts;
}

/** Shorten a long IPv6 so it doesn't stretch the tray menu; other forms pass through. */
function shortenIp(ip: string): string {
  const groups = ip.split(':');
  if (groups.length > 4) return `${groups[0]}:${groups[1]}:…:${groups[groups.length - 1]}`;
  return ip;
}

/** Device kind for a client from its info string, or null if unknown. */
export function clientDevice(info: string | null): string | null {
  return parseClientInfo(info).device ?? null;
}

export function versionLabel(appVersion: string, serverVersion: string | null): string {
  return serverVersion
    ? `Termcast ${appVersion} · server ${serverVersion}`
    : `Termcast ${appVersion}`;
}

/** Status ball prefixing a connections-list label. */
export function statusDot(connected: boolean): string {
  return connected ? '🟢' : '🟡';
}

/** Human label for a client row: its device kind, or 'iPhone' when unknown. */
export function clientLabel(info: string | null): string {
  return parseClientInfo(info).device ?? 'iPhone';
}

/** Disabled Details lines for a client, from its info string. */
export function clientDetailLines(info: string | null): string[] {
  const { ip, location, device } = parseClientInfo(info);
  const lines: string[] = [];
  if (ip) lines.push(`IP: ${shortenIp(ip)}`);
  if (location) lines.push(`Location: ${location}`);
  if (device) lines.push(`Device: ${device}`);
  return lines.length > 0 ? lines : ['(no info yet)'];
}

/**
 * True when an inbound client is another termcast server (device segment is
 * exactly "Server"). Such connections are the return leg of a mesh link and are
 * already shown as a named mesh-peer row, so the tray hides them as clients.
 */
export function isServerClient(info: string | null): boolean {
  return clientDevice(info) === 'Server';
}

/**
 * Detail lines for a mesh-peer row. IP/Location come from the peer's inbound leg
 * (attached server-side by deviceId); absent until the peer dials back. Device
 * is always "Server". No Port/Status — connectedness shows via the status dot.
 */
export function peerDetailLines(peer: { ip?: string; location?: string }): string[] {
  const lines: string[] = [];
  if (peer.ip) lines.push(`IP: ${shortenIp(peer.ip)}`);
  if (peer.location) lines.push(`Location: ${peer.location}`);
  lines.push('Device: Server');
  return lines;
}

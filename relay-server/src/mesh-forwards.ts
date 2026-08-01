// Pure helpers for mesh port forwarding: the persisted shape, sanitizers for
// untrusted input (disk / invite), the invite-vs-local merge policy, and the
// add/remove mutation shared by the CLI and the web API. No I/O here — this
// module is fully unit-testable.

export interface MeshForward {
  remotePort: number;            // port on the peer server
  localPort: number;             // listener port on this machine
  source: 'invite' | 'local';    // who configured it
}

/** Runtime view of one forward, exposed via status / web UI. */
export interface MeshForwardState {
  remotePort: number;
  localPort: number;
  state: 'pending' | 'active' | 'error';
  message?: string;
}

export function isValidPort(p: unknown): p is number {
  return Number.isInteger(p) && (p as number) >= 1 && (p as number) <= 65535;
}

function sanitize(raw: unknown, sourceFor: (entry: Record<string, unknown>) => 'invite' | 'local'): MeshForward[] {
  if (!Array.isArray(raw)) return [];
  const out: MeshForward[] = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const entry = f as Record<string, unknown>;
    const remotePort = entry.remotePort;
    const localPort = entry.localPort ?? remotePort;
    if (!isValidPort(remotePort) || !isValidPort(localPort)) continue;
    if (out.some(e => e.remotePort === remotePort)) continue; // dedupe, first wins
    out.push({ remotePort, localPort, source: sourceFor(entry) });
  }
  return out;
}

/** Sanitize forwards arriving in a mesh invite. The source is always 'invite' —
 *  a remote payload must not be able to mint 'local' entries. */
export function forwardsFromInvite(raw: unknown): MeshForward[] {
  return sanitize(raw, () => 'invite');
}

/** Sanitize forwards loaded from mesh-peers.json, preserving a stored 'local'
 *  source. Anything else (missing/garbage) degrades to 'invite'. */
export function forwardsFromDisk(raw: unknown): MeshForward[] {
  return sanitize(raw, entry => (entry.source === 'local' ? 'local' : 'invite'));
}

/** Merge policy on mesh_invite: the invite replaces all previous invite-sourced
 *  forwards; local forwards always survive; on a remotePort collision the
 *  local entry wins (so the CLI can remap an invite forward's local port). */
export function mergeMeshForwards(existing: MeshForward[], incomingInvite: MeshForward[]): MeshForward[] {
  const out = existing.filter(f => f.source === 'local');
  for (const f of incomingInvite) {
    if (out.some(e => e.remotePort === f.remotePort)) continue;
    out.push({ ...f, source: 'invite' });
  }
  return out;
}

export interface ForwardChange {
  /** Peer name (case-insensitive exact) or deviceId prefix. */
  peer: string;
  action: 'add' | 'remove';
  remotePort: number;
  /** add only; defaults to remotePort */
  localPort?: number;
}

/** Structural subset of MeshPeer this module needs (avoids importing mesh-client). */
export interface ForwardablePeer {
  name: string;
  deviceId: string;
  remotePort: number;   // the peer's ttyd port (always forwarded)
  localPort: number;    // local port of the ttyd forward
  forwards?: MeshForward[];
}

export type ForwardChangeResult<T> =
  | { ok: true; peers: T[]; peer: T; note?: string }
  | { ok: false; error: string };

export function applyForwardChange<T extends ForwardablePeer>(
  peers: T[],
  change: ForwardChange,
): ForwardChangeResult<T> {
  if (!isValidPort(change.remotePort)) {
    return { ok: false, error: `Invalid remote port: ${change.remotePort}` };
  }
  const localPort = change.localPort ?? change.remotePort;
  if (change.action === 'add' && !isValidPort(localPort)) {
    return { ok: false, error: `Invalid local port: ${change.localPort}` };
  }

  const q = change.peer.toLowerCase();
  const matches = peers.filter(p => p.name.toLowerCase() === q || p.deviceId.toLowerCase().startsWith(q));
  if (matches.length === 0) {
    return { ok: false, error: `No meshed peer matches "${change.peer}". Run: termcast mesh forwards` };
  }
  if (matches.length > 1) {
    return { ok: false, error: `"${change.peer}" matches multiple peers: ${matches.map(p => p.name).join(', ')}` };
  }
  const target = matches[0];
  const forwards = target.forwards ?? [];

  let next: MeshForward[];
  let note: string | undefined;

  if (change.action === 'add') {
    if (change.remotePort === target.remotePort) {
      return { ok: false, error: `Port ${change.remotePort} is ${target.name}'s terminal port — already forwarded to localhost:${target.localPort}` };
    }
    const localClash = forwards.find(f => f.remotePort !== change.remotePort && f.localPort === localPort);
    if (localClash) {
      return { ok: false, error: `Local port ${localPort} is already used by the forward to :${localClash.remotePort}` };
    }
    const replaced = forwards.find(f => f.remotePort === change.remotePort);
    next = [
      ...forwards.filter(f => f.remotePort !== change.remotePort),
      { remotePort: change.remotePort, localPort, source: 'local' },
    ];
    if (replaced) note = `Replaced existing forward localhost:${replaced.localPort} → :${replaced.remotePort}`;
  } else {
    const entry = forwards.find(f => f.remotePort === change.remotePort);
    if (!entry) {
      return { ok: false, error: `No forward for port ${change.remotePort} on ${target.name}` };
    }
    next = forwards.filter(f => f.remotePort !== change.remotePort);
    if (entry.source === 'invite') {
      note = 'This forward came from the iOS app — it will return on the next mesh invite unless removed there.';
    }
  }

  const updatedPeer = { ...target, forwards: next };
  return {
    ok: true,
    peers: peers.map(p => (p.deviceId === target.deviceId ? updatedPeer : p)),
    peer: updatedPeer,
    note,
  };
}

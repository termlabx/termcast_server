export interface MeshPeer {
  name: string;
  port: number;
}

export type Selection = { peer: MeshPeer } | { error: string };

/**
 * Resolve a user's selection (CLI arg or prompt answer) against the peer list.
 * Accepts a 1-based index or a case-insensitive exact name. Pure — no I/O.
 */
export function resolvePeerSelection(peers: MeshPeer[], arg: string): Selection {
  if (peers.length === 0) return { error: 'No other servers available.' };
  const trimmed = arg.trim();
  if (trimmed === '') return { error: 'No selection provided.' };

  if (/^\d+$/.test(trimmed)) {
    const idx = parseInt(trimmed, 10) - 1;
    if (idx < 0 || idx >= peers.length) {
      return { error: `Invalid selection: ${trimmed} (expected 1-${peers.length})` };
    }
    return { peer: peers[idx] };
  }

  const match = peers.find(p => p.name.toLowerCase() === trimmed.toLowerCase());
  if (!match) return { error: `No server named "${trimmed}"` };
  return { peer: match };
}

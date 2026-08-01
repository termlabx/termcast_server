export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface ClusterState {
  pairedAt: number;    // epoch ms; the lease anchor for one phone's session
  sessionName: string; // tmux session name, e.g. "tc_<phoneId>"
}
export type ClusterMap = Record<string, ClusterState>; // keyed by phoneId

/** tmux-safe session name; MUST match the ttyd wrapper's computation. */
export function sessionNameFor(phoneId: string): string {
  return 'tc_' + phoneId.replace(/[^A-Za-z0-9_]/g, '_');
}

export function isActiveCluster(state: { pairedAt: number }, now: number = Date.now()): boolean {
  return now < state.pairedAt + SEVEN_DAYS_MS;
}

export function hasActiveCluster(clusters: ClusterMap, now: number = Date.now()): boolean {
  return Object.values(clusters).some((c) => isActiveCluster(c, now));
}

// --- Mesh association anchor (server-local, phone-agnostic) ---
//
// The server↔server mesh lifetime is anchored on a single persisted epoch-ms
// value, `meshPairedAt`, so it survives the phone being offline and does NOT
// depend on a phone sending `phone_id` (that only drives per-phone tmux
// sessions). Encoding:
//   > 0  associated at that time; mesh active until +7d (set on QR show and on
//        receiving a mesh invite — the scan/association event)
//   = 0  never associated
//   < 0  ejected/left — durable isolation until re-consent (showing the QR)

/** Sentinel meaning "this machine was ejected/left the cluster". */
export const MESH_EJECTED = -1;

export function isMeshActive(meshPairedAt: number, now: number = Date.now()): boolean {
  return meshPairedAt > 0 && now < meshPairedAt + SEVEN_DAYS_MS;
}

export function isMeshEjected(meshPairedAt: number): boolean {
  return meshPairedAt < 0;
}

/** Insert or refresh a phone's cluster, keeping the newest pairedAt (hard cap). */
export function upsertCluster(
  clusters: ClusterMap, phoneId: string, reportedPairedAt: number, now: number = Date.now(),
): ClusterMap {
  const prev = clusters[phoneId];
  const pairedAt = Math.max(prev?.pairedAt ?? 0, reportedPairedAt || now);
  return { ...clusters, [phoneId]: { pairedAt, sessionName: sessionNameFor(phoneId) } };
}

/** Split into the surviving map and the session names of expired clusters. */
export function sweepExpiredClusters(
  clusters: ClusterMap, now: number = Date.now(),
): { kept: ClusterMap; expired: string[] } {
  const kept: ClusterMap = {};
  const expired: string[] = [];
  for (const [id, c] of Object.entries(clusters)) {
    if (isActiveCluster(c, now)) kept[id] = c;
    else expired.push(c.sessionName);
  }
  return { kept, expired };
}

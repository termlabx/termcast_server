// Derives the single status the tray icon badge shows, from the server process
// state plus the relay connectivity reported by GET /api/status. Kept free of
// Electron imports so it can be unit-tested with node:test.

export type TrayStatus = 'connected' | 'connecting' | 'offline';

/** How long the relay may stay down before the badge turns red. The relay
 *  reconnects on its own, so a routine blip should read as "connecting". */
export const RELAY_GRACE_MS = 30_000;

export interface TrayStatusInput {
  serverStarting: boolean;
  serverRunning: boolean;
  /** relay.connected from /api/status; null when it hasn't answered yet. */
  relayConnected: boolean | null;
  /** How long the relay has been not-connected, in ms; 0 while connected. */
  relayDownMs: number;
}

export function trayStatus(i: TrayStatusInput): TrayStatus {
  // A dead server outranks whatever the last relay reading said.
  if (!i.serverStarting && !i.serverRunning) return 'offline';
  if (i.serverStarting) return 'connecting';
  if (i.relayConnected === true) return 'connected';
  return i.relayDownMs >= RELAY_GRACE_MS ? 'offline' : 'connecting';
}

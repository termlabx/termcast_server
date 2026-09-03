/**
 * Guards against two termcast daemons sharing one `~/.ttyd-server` identity.
 *
 * Both the shell-installed CLI and the Termcast.app tray daemon run the same
 * `start` command against the same `config.json`. If two instances are alive
 * at once they join the same relay room, and the room tolerates exactly one
 * server socket (relay-backend/src/relay-room.ts): each reconnect evicts the
 * other's socket *and* every connected phone with it, forever. `start` checks
 * this before any side effect (spawning ttyd, connecting to the relay) runs —
 * fixing it up after the fact is too late, the damage is the eviction itself.
 */

export interface RunningState {
  pid: number;
  webPort?: number;
}

/** Parse `state.json`'s content into a running-state record, or null if there's no usable pid. */
export function parseRunningState(raw: string): RunningState | null {
  try {
    const state = JSON.parse(raw) as { pid?: number; webPort?: number };
    if (!state.pid) return null;
    return { pid: state.pid, webPort: state.webPort };
  } catch {
    return null;
  }
}

export type KillProbe = (pid: number, signal: 0) => void;

/**
 * Whether a recorded pid is still alive. `kill(pid, 0)` sends no signal but
 * throws ESRCH once the process is gone, and throws EPERM when the pid is
 * alive but owned by someone else — that's still a conflict, so only ESRCH
 * (and nothing else unexpected) means it's safe to proceed.
 */
export function isPidAlive(pid: number, probe: KillProbe): boolean {
  try {
    probe(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

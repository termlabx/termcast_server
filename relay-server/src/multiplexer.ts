/**
 * Which terminal multiplexer this machine runs. One at a time, machine-wide —
 * but each keeps its own session namespace, so switching leaves the other's
 * sessions dormant rather than destroying them.
 */
export type Multiplexer = 'tmux' | 'herdr' | 'none';

export const MULTIPLEXERS: readonly Multiplexer[] = ['tmux', 'herdr', 'none'];

/** Anything unrecognised (including a legacy config with no field) means tmux. */
export function parseMultiplexer(value: unknown): Multiplexer {
  return MULTIPLEXERS.includes(value as Multiplexer) ? (value as Multiplexer) : 'tmux';
}

/**
 * Session-name prefix per multiplexer. `tc_` is load-bearing: it MUST stay
 * byte-identical to the pre-herdr scheme or every existing tmux session is
 * orphaned on upgrade.
 */
export function sessionPrefix(mux: Multiplexer): string {
  return mux === 'herdr' ? 'tch_' : 'tc_';
}

/**
 * Session name for a phone under one multiplexer. MUST match the wrapper
 * script's computation in buildMultiplexerShellArgs().
 */
export function sessionNameFor(phoneId: string, mux: Multiplexer = 'tmux'): string {
  return sessionPrefix(mux) + phoneId.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Resolve the effective multiplexer from stored config plus CLI flags.
 * Precedence: explicit --multiplexer > --no-tmux > stored config > tmux.
 */
export function multiplexerFromConfig(
  config: { multiplexer?: unknown },
  flags: { multiplexer?: unknown; tmux?: boolean } = {},
): Multiplexer {
  if (flags.multiplexer !== undefined) return parseMultiplexer(flags.multiplexer);
  if (flags.tmux === false) return 'none';
  return parseMultiplexer(config.multiplexer);
}

/** Shell command that tears down one session, or null when there is nothing to kill. */
export function killSessionCommand(name: string, mux: Multiplexer): string | null {
  const safe = name.replace(/'/g, '');
  if (mux === 'tmux') return `tmux kill-session -t '${safe}' 2>/dev/null`;
  // herdr's CLI exposes only `session list` and `session attach`; teardown goes
  // through the per-session server, selected by HERDR_SESSION.
  if (mux === 'herdr') return `HERDR_SESSION='${safe}' herdr server stop 2>/dev/null`;
  return null;
}

/** Every teardown command for one phone, across all session namespaces. */
export function killCommandsForPhone(phoneId: string): string[] {
  return MULTIPLEXERS
    .map((m) => killSessionCommand(sessionNameFor(phoneId, m), m))
    .filter((c): c is string => c !== null);
}

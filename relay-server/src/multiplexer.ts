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
  // herdr keeps one server per named session, each on its own socket under
  // ~/.config/herdr/sessions/<name>/. `herdr session stop` is the only form that
  // addresses a session by name: there is no HERDR_SESSION env var (the binary
  // reads only HERDR_DEBUG_OSC_EVIDENCE, HERDR_ENV, HERDR_RENDER_ENCODING), so
  // an env-var form would silently fall through to the *default* socket and stop
  // the user's own herdr session while leaving ours running. Verified v0.7.5.
  //
  // `stop` halts the server but leaves the session listed as `stopped` with its
  // directory intact; `delete` reclaims it. Expiry means gone, so we do both.
  // Both are idempotent — a missing session reports a JSON error and exits 0.
  if (mux === 'herdr') {
    return `herdr session stop '${safe}' >/dev/null 2>&1; herdr session delete '${safe}' >/dev/null 2>&1`;
  }
  return null;
}

/** Human-readable status block shared by `termcast multiplexer` and the logs. */
export function describeMultiplexerStatus(
  active: Multiplexer, installed: { tmux: boolean; herdr: boolean },
): string {
  return MULTIPLEXERS.map((m) => {
    const mark = m === active ? '● ' : '  ';
    // 'none' is the bare shell — there is no binary, so an install state would
    // be meaningless.
    const state = m === 'none' ? '' : installed[m] ? ' (installed)' : ' (not installed)';
    return `${mark}${m}${state}${m === active ? ' — active' : ''}`;
  }).join('\n');
}

/** Every teardown command for one phone, across all session namespaces. */
export function killCommandsForPhone(phoneId: string): string[] {
  return MULTIPLEXERS
    .map((m) => killSessionCommand(sessionNameFor(phoneId, m), m))
    .filter((c): c is string => c !== null);
}

/** POSIX single-quote escaping: close, escaped quote, reopen. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Command that types `text` into a session and presses Enter, or null when the
 * multiplexer has no injection mechanism.
 *
 * tmux needs `-l` so the payload is taken literally: without it, text
 * containing key names like "Enter" or "C-c" would be interpreted as keys.
 * The text and Enter are separate calls because `-l` suppresses key-name
 * interpretation for everything in that call, including the Enter itself.
 *
 * herdr v0.7.5 has no `session send`; the verified form is `herdr agent prompt
 * <target> <text>`, which submits a prompt to the agent in that session.
 */
export function sendKeysCommand(sessionName: string, text: string, mux: Multiplexer): string | null {
  if (!text.trim()) return null;
  const target = shellQuote(sessionName);
  const body = shellQuote(text);

  if (mux === 'tmux') {
    return `tmux send-keys -t ${target} -l ${body} && tmux send-keys -t ${target} Enter`;
  }
  if (mux === 'herdr') {
    return `herdr agent prompt ${target} ${body}`;
  }
  return null;
}

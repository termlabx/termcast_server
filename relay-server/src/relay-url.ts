// Relay endpoint resolution.
//
// Termcast ships NO default relay. The daemon must be told which relay to use,
// via `--relay` or TERMCAST_RELAY_URL, and refuses to start otherwise. That
// keeps any particular operator's relay address out of the source tree and
// makes self-hosting the default posture rather than an override.

const WS_SCHEMES = ['wss://', 'ws://'];
const HTTP_SCHEMES = ['https://', 'http://'];

export type RelayUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

/** Guidance printed when no relay is configured, or one is malformed. */
export const RELAY_HELP = [
  'Termcast ships no default relay — point it at one:',
  '',
  '  termcast start --relay wss://relay.example.com',
  '',
  'or set it once, so every command picks it up:',
  '',
  '  export TERMCAST_RELAY_URL=wss://relay.example.com',
  '',
  'See README.md ("Relay") for running your own.',
].join('\n');

/**
 * Resolve the relay URL from the `--relay` flag, else TERMCAST_RELAY_URL.
 * Accepts ws/wss/http/https and normalises to the ws form the rest of the
 * code expects; returns an error result when unset or unusable.
 */
export function resolveRelayUrl(
  flag?: string,
  env: NodeJS.ProcessEnv = process.env,
): RelayUrlResult {
  const raw = (flag ?? env.TERMCAST_RELAY_URL ?? '').trim();
  if (!raw) return { ok: false, error: `No relay URL configured.\n\n${RELAY_HELP}` };

  const trimmed = raw.replace(/\/+$/, '');
  const scheme = [...WS_SCHEMES, ...HTTP_SCHEMES].find(s => trimmed.startsWith(s));
  if (!scheme) {
    return { ok: false, error: `Relay URL must start with wss:// or ws:// — got "${raw}".\n\n${RELAY_HELP}` };
  }
  // Reject a bare scheme with no host ("wss://", "wss:///path").
  const host = trimmed.slice(scheme.length).split('/')[0];
  if (!host) return { ok: false, error: `Relay URL "${raw}" has no host.\n\n${RELAY_HELP}` };

  return { ok: true, url: trimmed.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://') };
}

/** The HTTP origin for a ws relay URL — what the REST endpoints are called on. */
export function relayHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
}

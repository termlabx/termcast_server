// Pure decision logic for `termcast upgrade`. The side effects (downloading,
// extracting, spawning npm, prompting) live in index.ts; everything here is
// deterministic and unit-tested.
//
// The release-URL/key helpers below intentionally mirror scripts/download.mjs.
// That .mjs is shipped in the npm tarball but NOT in the shell-install tarball
// (build-release.sh packages `dist/ package.json` only), so the upgrade command
// — which must run on both — cannot depend on it at runtime. These compiled-in
// copies are always present.
import { sep } from 'node:path';

// Public download host for release assets. Override with TERMCAST_RELEASES_URL
// to self-host. Distinct from the relay, which has no default at all — see
// relay-url.ts.
const DEFAULT_BASE_URL = 'https://termcast.download.ulixlab.com';
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux']);
const SUPPORTED_ARCHS = new Set(['x64', 'arm64']);

export interface BinaryKeys {
  platform: string;
  arch: string;
  supported: boolean;
  termcastd: string;
  tmux: string;
}

/** Release-asset keys for a platform/arch, and whether we ship binaries for it. */
export function binaryKeys(platform: string = process.platform, arch: string = process.arch): BinaryKeys {
  const supported = SUPPORTED_PLATFORMS.has(platform) && SUPPORTED_ARCHS.has(arch);
  return { platform, arch, supported, termcastd: `termcastd-${platform}-${arch}`, tmux: `tmux-${platform}-${arch}` };
}

/** Releases base URL, overridable for testing / self-hosting. */
export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.TERMCAST_RELEASES_URL || DEFAULT_BASE_URL;
}

/** Build `${base}/releases/${key}` with an optional `?via=` metrics marker. */
export function releaseUrl(baseUrl: string, key: string, opts: { via?: string } = {}): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = opts.via ? `?via=${encodeURIComponent(opts.via)}` : '';
  return `${base}/releases/${key}${suffix}`;
}

export type InstallKind = 'shell' | 'npm';

/**
 * Decide how this CLI was installed from the path of the running script.
 *
 * The shell installer (`scripts/install.sh`) lays the CLI down under
 * `<home>/.termcast/` and wraps it in a supervisor; npm installs it under a
 * global node_modules prefix. We only treat a script as a shell install when it
 * lives under *this* user's `~/.termcast` — another user's `.termcast` in the
 * path (e.g. a system-wide copy) must not be mistaken for ours.
 */
export function detectInstall(scriptPath: string, home: string): InstallKind {
  const root = home.replace(/[/\\]+$/, '') + sep + '.termcast' + sep;
  return scriptPath.startsWith(root) ? 'shell' : 'npm';
}

export type RestartPlan = 'auto' | 'manual-foreground' | 'none';

/**
 * Decide what to do about the running server after an upgrade.
 *  - `auto`: a supervisor is alive and its wrapper exists, so we can offer to
 *    restart it for the user (`termcast restart`).
 *  - `manual-foreground`: a server process is running but we can't drive a
 *    restart (foreground/npm install) — tell the user to restart it.
 *  - `none`: nothing is running; the new version applies on next `start`.
 */
export function decideRestart(opts: {
  supervisorAlive: boolean;
  wrapperExists: boolean;
  foregroundAlive: boolean;
}): RestartPlan {
  if (opts.supervisorAlive && opts.wrapperExists) return 'auto';
  if (opts.foregroundAlive) return 'manual-foreground';
  return 'none';
}

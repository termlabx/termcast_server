// herdr ships one static binary per platform/arch as a GitHub release asset.
// Unlike the tmux binaries (mirrored into our own release bucket), herdr is
// pulled straight from github.com/herdrdev/herdr, so every download is verified
// against the sha256 digest the release API publishes for that asset.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const PINNED_VERSION = 'v0.7.5';
const REPO = 'herdrdev/herdr';

/** Node's platform/arch → herdr's release-asset naming. null = we ship nothing. */
export function herdrAssetName(platform: string, arch: string): string | null {
  const os = platform === 'darwin' ? 'macos' : platform === 'linux' ? 'linux' : null;
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null;
  return os && cpu ? `herdr-${os}-${cpu}` : null;
}

export function herdrVersion(env: NodeJS.ProcessEnv = process.env): string {
  return env.TERMCAST_HERDR_VERSION || PINNED_VERSION;
}

export function releaseApiUrl(version: string): string {
  return `https://api.github.com/repos/${REPO}/releases/tags/${version}`;
}

export function assetDownloadUrl(version: string, asset: string): string {
  return `https://github.com/${REPO}/releases/download/${version}/${asset}`;
}

export interface GitHubRelease {
  assets: { name: string; browser_download_url: string; digest?: string }[];
}

/** Locate one asset in a release payload and pull out its published sha256. */
export function pickAsset(release: GitHubRelease, asset: string): { url: string; sha256: string | null } {
  const found = release.assets?.find((a) => a.name === asset);
  if (!found) throw new Error(`herdr release has no asset named ${asset}`);
  const digest = found.digest ?? null;
  return {
    url: found.browser_download_url,
    sha256: digest && digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : null,
  };
}

/** An absent digest is a failure, never a pass — we refuse to install what we can't verify. */
export function verifySha256(bytes: Buffer, expected: string | null): boolean {
  if (!expected) return false;
  return createHash('sha256').update(bytes).digest('hex') === expected.toLowerCase();
}

/**
 * Download and verify herdr into `destPath`. Throws on any failure; the caller
 * logs and carries on with the current multiplexer — installing herdr is never
 * fatal to the server.
 */
export async function downloadHerdr(destPath: string, opts: {
  platform?: string; arch?: string; env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
} = {}): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const doFetch = opts.fetchFn ?? fetch;

  const asset = herdrAssetName(platform, arch);
  if (!asset) throw new Error(`herdr has no build for ${platform}-${arch}`);

  const version = herdrVersion(opts.env);
  const metaResp = await doFetch(releaseApiUrl(version), {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'termcast' },
  });
  if (!metaResp.ok) throw new Error(`release lookup failed: HTTP ${metaResp.status}`);
  const { url, sha256 } = pickAsset(await metaResp.json() as GitHubRelease, asset);

  const binResp = await doFetch(url);
  if (!binResp.ok) throw new Error(`download failed: HTTP ${binResp.status}`);
  const bytes = Buffer.from(await binResp.arrayBuffer());

  if (!verifySha256(bytes, sha256)) {
    // Leave any existing binary untouched — a bad download must not replace a
    // working install.
    throw new Error('sha256 mismatch — refusing to install');
  }

  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, bytes, { mode: 0o755 });
}

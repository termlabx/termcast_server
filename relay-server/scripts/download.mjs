// Shared download helper for the @termcast npm postinstall scripts.
//
// Pure Node, no dependencies. Resolves release URLs, fetches with redirect
// following (the global `fetch` follows 3xx), writes atomically (temp file +
// rename), verifies a non-empty body, and chmods the result.
//
// NOTE: @termcast/cli and @termcast/macos-app are published as separate npm
// packages, so each ships its own copy of this file (npm postinstall only sees
// the installed package's own `files`). Keep the two copies in sync:
//   - relay-server/scripts/download.mjs   (canonical, tested)
//   - npm-macos-app/download.mjs          (copy)
import { rename, chmod, unlink, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Public download host fronting the release assets. Override with
// TERMCAST_RELEASES_URL to self-host.
export const DEFAULT_BASE_URL = 'https://termcast.download.ulixlab.com';

const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux']);
const SUPPORTED_ARCHS = new Set(['x64', 'arm64']);

/**
 * Build the release-asset keys for a platform/arch and report whether we ship
 * binaries for it. Defaults to the current process when args are omitted.
 */
export function binaryKeys(platform = process.platform, arch = process.arch) {
  const supported = SUPPORTED_PLATFORMS.has(platform) && SUPPORTED_ARCHS.has(arch);
  return {
    platform,
    arch,
    supported,
    termcastd: `termcastd-${platform}-${arch}`,
    tmux: `tmux-${platform}-${arch}`,
  };
}

/** Resolve the releases base URL, allowing override for testing / self-hosting. */
export function resolveBaseUrl(env = process.env) {
  return env.TERMCAST_RELEASES_URL || DEFAULT_BASE_URL;
}

/** Build `${base}/releases/${key}` with an optional `?via=` metrics marker. */
export function releaseUrl(baseUrl, key, { via } = {}) {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = via ? `?via=${encodeURIComponent(via)}` : '';
  return `${base}/releases/${key}${suffix}`;
}

/**
 * Download `url` to `destPath`. Follows redirects, rejects non-2xx and empty
 * bodies, writes to a temp file then renames into place (so a partial download
 * never leaves a corrupt binary), and chmods the result. Throws on any failure;
 * never leaves a temp file behind.
 */
export async function downloadToFile(url, destPath, { mode = 0o755 } = {}) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`download failed: ${url} -> HTTP ${res.status}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error(`download failed: ${url} -> empty body`);
  }
  await mkdir(dirname(destPath), { recursive: true });
  const tmp = join(dirname(destPath), `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await writeFile(tmp, bytes, { mode });
    await chmod(tmp, mode);
    await rename(tmp, destPath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

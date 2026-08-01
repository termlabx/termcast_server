#!/usr/bin/env node
// Postinstall for `npm install -g @termcast/cli`.
//
// Populates the package's bin/ directory with the native binaries the runtime
// (src/ttyd-manager.ts) looks up: termcastd-{platform}-{arch} (required) and
// tmux-{platform}-{arch} (best-effort). Binaries are NOT shipped in the npm
// tarball — they're downloaded here, reusing the existing /releases/ infra.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binaryKeys, releaseUrl, resolveBaseUrl, downloadToFile } from './download.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binDir = join(__dirname, '..', 'bin');
const base = resolveBaseUrl();
const keys = binaryKeys();

if (!keys.supported) {
  console.warn(
    `[termcast] No prebuilt binaries for ${keys.platform}-${keys.arch}; ` +
      `Termcast supports macOS and Linux on x64/arm64. Skipping binary download.`,
  );
  process.exit(0); // don't hard-fail npm on an unsupported platform
}

async function fetchBinary(key, { required }) {
  const dest = join(binDir, key);
  if (existsSync(dest)) {
    return; // idempotent: a re-install keeps the existing binary
  }
  const url = releaseUrl(base, key, { via: 'npm' });
  try {
    await downloadToFile(url, dest, { mode: 0o755 });
    console.log(`[termcast] installed ${key}`);
  } catch (err) {
    if (required) {
      console.error(`[termcast] failed to download ${key}: ${err.message}`);
      console.error(`  → Retry, or download manually from ${url} into ${binDir}/`);
      process.exit(1); // the CLI cannot run without termcastd
    }
    console.warn(`[termcast] ${key} unavailable (${err.message}); continuing without tmux.`);
  }
}

await fetchBinary(keys.termcastd, { required: true });
await fetchBinary(keys.tmux, { required: false });

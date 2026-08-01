import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Insert our clipboard script immediately after the opening <head> tag so it
 * runs before ttyd's body bundle. Running first lets the script wrap
 * window.WebSocket and capture the terminal socket for paste injection.
 */
export function injectClipboardScript(html: string, scriptContent: string): string {
  const m = html.match(/<head[^>]*>/i);
  if (!m) throw new Error('cannot augment terminal client: no <head> tag found');
  const tag = m[0];
  return html.replace(tag, `${tag}<script>${scriptContent}</script>`);
}

/**
 * Deterministic cache path for the augmented index. Keyed by ttyd version and a
 * hash of the injected script so a new ttyd binary or an edited script
 * regenerates the cached file rather than serving a stale copy.
 */
export function augmentedIndexPath(cacheDir: string, version: string, scriptContent: string): string {
  const safeVersion = version.replace(/[^a-zA-Z0-9._-]/g, '_');
  const hash = createHash('sha256').update(scriptContent).digest('hex').slice(0, 8);
  return join(cacheDir, `ttyd-index-${safeVersion}-${hash}.html`);
}

/** Reads the committed browser clipboard script that gets injected into ttyd's client. */
function readClipboardScript(): string {
  const candidates = [
    join(__dirname, 'assets', 'browser-clipboard.js'),
    join(__dirname, '..', 'src', 'assets', 'browser-clipboard.js'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf-8');
  }
  throw new Error('browser-clipboard.js asset not found');
}

/** Fetches ttyd's default index.html by briefly running it on an ephemeral port. */
async function fetchTtydIndex(ttydPath: string): Promise<string> {
  const port = 39000 + Math.floor(Math.random() * 20000);
  const child = spawn(ttydPath, [
    '--port', String(port),
    '--interface', '127.0.0.1',
    '--once',
    '/bin/sh', '-c', 'sleep 5',
  ], { stdio: 'ignore' });
  try {
    // Poll until ttyd answers, then grab the page.
    const deadline = Date.now() + 4000;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/`);
        if (resp.ok) return await resp.text();
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`could not read terminal client index: ${String(lastErr)}`);
  } finally {
    try { child.kill('SIGKILL'); } catch {}
  }
}

/**
 * Ensure an augmented ttyd index.html exists on disk and return its path, for
 * passing to ttyd via `-I`. The augmented page is ttyd's own client plus our
 * injected clipboard script. Cached per ttyd-version + script-hash; on a cache
 * hit no ttyd subprocess is spawned.
 *
 * Best-effort: returns null if generation fails, so the caller can fall back to
 * ttyd's stock client rather than failing to start.
 */
export async function ensureAugmentedIndex(ttydPath: string, version: string): Promise<string | null> {
  try {
    const script = readClipboardScript();
    const cacheDir = join(homedir(), '.termcast', 'cache');
    const outPath = augmentedIndexPath(cacheDir, version, script);
    if (existsSync(outPath)) return outPath;

    const stockHtml = await fetchTtydIndex(ttydPath);
    const augmented = injectClipboardScript(stockHtml, script);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(outPath, augmented, 'utf-8');
    return outPath;
  } catch (err) {
    console.error(`Could not build augmented terminal client (${(err as Error).message}); using stock client.`);
    return null;
  }
}

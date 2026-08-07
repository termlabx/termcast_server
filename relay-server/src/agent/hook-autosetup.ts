import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import {
  stageHookScripts, installHooks, hooksInstalled, hookSettingsPath, hookInstallDir,
} from './hook-install.js';

/**
 * What `ensureHooks` did. Only 'installed' and 'failed' are worth telling the
 * user about; the rest are the routine steady state on every later start.
 */
export type EnsureHooksResult =
  | 'installed' | 'already' | 'opted-out' | 'no-claude' | 'failed';

export interface EnsureHooksDeps {
  claudeDir?: string;
  settingsPath?: string;
  hookDir?: string;
  optOutPath?: string;
}

/** Termcast's own state dir, deliberately not inside the user's ~/.claude. */
export function optOutPath(): string {
  return join(homedir(), '.ttyd-server', 'agent-hooks-optout');
}

function claudeDir(): string {
  return join(homedir(), '.claude');
}

/**
 * Record that the user removed the hooks on purpose, so the next daemon start
 * leaves them removed. Existence is the signal; the timestamp is only there for
 * whoever reads the file wondering what it is.
 */
export function writeOptOut(path: string = optOutPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${new Date().toISOString()}\n`, { mode: 0o600 });
}

export function clearOptOut(path: string = optOutPath()): void {
  try {
    unlinkSync(path);
  } catch {
    // Never set, or already gone.
  }
}

function readSettingsForCheck(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

/**
 * Install the Claude Code hooks unless we have been told not to.
 *
 * Called on every daemon start, which is what makes a fresh install work with
 * no manual step: without these hooks nothing records which pane holds a
 * session, so a Claude session in tmux is invisible to the phone *and* the
 * guard that should refuse the send stays silent — the message gets answered
 * headlessly while the user's own terminal shows nothing.
 *
 * Every path is a parameter so tests never go near a real home directory.
 */
export function ensureHooks(deps: EnsureHooksDeps = {}): EnsureHooksResult {
  const paths = {
    claudeDir: deps.claudeDir ?? claudeDir(),
    settingsPath: deps.settingsPath ?? hookSettingsPath(),
    hookDir: deps.hookDir ?? hookInstallDir(),
    optOutPath: deps.optOutPath ?? optOutPath(),
  };

  try {
    // Claude Code is not installed. Creating a config directory for an app the
    // user does not have is litter, and the hooks would have nothing to hook.
    if (!existsSync(paths.claudeDir)) return 'no-claude';

    // Re-staged on every start, including when the entries are already in
    // place: an upgrade ships new hook scripts, but settings.json still points
    // at ~/.ttyd-server/hooks/*.sh, so without this they stay at the old
    // version forever.
    stageHookScripts(paths.hookDir);

    // Checked before the opt-out marker on purpose: someone who ran `termcast
    // agent setup` by hand must never be reported as opted out.
    //
    // A missing settings.json is the normal state of a Claude Code install that
    // has not needed one yet — it means "no hooks", not a failure. Malformed
    // JSON is a different matter and is left to installHooks, which refuses
    // rather than overwriting it.
    if (hooksInstalled(readSettingsForCheck(paths.settingsPath))) return 'already';

    if (existsSync(paths.optOutPath)) return 'opted-out';

    installHooks(paths.settingsPath, { hookDir: paths.hookDir });
    return 'installed';
  } catch {
    // A malformed or unwritable settings.json. Phone approvals and desk
    // injection are degraded features, not preconditions for serving a
    // terminal, so this is reported and the daemon carries on.
    return 'failed';
  }
}

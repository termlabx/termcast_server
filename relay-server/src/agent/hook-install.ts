import { readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** Tags every entry we add so removal never touches the user's own hooks. */
export const HOOK_MARKER = 'termcast-agent';

export function hookSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

export function hookInstallDir(): string {
  return join(homedir(), '.ttyd-server', 'hooks');
}

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
}

type Settings = Record<string, unknown> & { hooks?: Record<string, HookEntry[]> };

function isOurs(entry: HookEntry): boolean {
  return entry.hooks?.some((hook) => hook.command?.includes(HOOK_MARKER)) ?? false;
}

export function hooksInstalled(settings: Settings): boolean {
  return (settings.hooks?.PermissionRequest ?? []).some(isOurs);
}

/**
 * Add our hooks to Claude Code's settings.
 *
 * Only ever called from `termcast agent setup`. This changes how every Claude
 * Code session on the machine is approved, so it is additive, idempotent, and
 * exactly reversible — and a malformed settings file aborts rather than being
 * overwritten.
 */
export function installHooks(settingsPath: string, opts: { hookDir: string }): void {
  const settings = readSettings(settingsPath);
  const hooks = settings.hooks ?? {};

  const permission = join(opts.hookDir, `${HOOK_MARKER}-permission.sh`);
  const session = join(opts.hookDir, `${HOOK_MARKER}-session.sh`);

  hooks.PermissionRequest = withOurs(hooks.PermissionRequest, {
    matcher: '*',
    hooks: [{ type: 'command', command: permission, timeout: 570 }],
  });
  hooks.SessionStart = withOurs(hooks.SessionStart, {
    hooks: [{ type: 'command', command: session, timeout: 5 }],
  });
  hooks.SessionEnd = withOurs(hooks.SessionEnd, {
    hooks: [{ type: 'command', command: session, timeout: 5 }],
  });

  settings.hooks = hooks;
  writeSettings(settingsPath, settings);
}

export function removeHooks(settingsPath: string): void {
  const settings = readSettings(settingsPath);
  if (!settings.hooks) return;

  for (const event of Object.keys(settings.hooks)) {
    const kept = settings.hooks[event].filter((entry) => !isOurs(entry));
    if (kept.length > 0) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  writeSettings(settingsPath, settings);
}

/** Copy the shipped scripts to a stable location and make them executable. */
export function stageHookScripts(hookDir: string = hookInstallDir()): void {
  mkdirSync(hookDir, { recursive: true });
  const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
  for (const [asset, name] of [
    ['agent-permission-hook.sh', `${HOOK_MARKER}-permission.sh`],
    ['agent-session-hook.sh', `${HOOK_MARKER}-session.sh`],
  ] as const) {
    const target = join(hookDir, name);
    copyFileSync(join(assets, asset), target);
    chmodSync(target, 0o755);
  }
}

function withOurs(existing: HookEntry[] | undefined, entry: HookEntry): HookEntry[] {
  return [...(existing ?? []).filter((e) => !isOurs(e)), entry];
}

function readSettings(path: string): Settings {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Settings;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    // Malformed JSON: refuse rather than overwrite the user's configuration.
    throw new Error(`Cannot parse ${path}. Fix or move it, then re-run setup.`);
  }
}

function writeSettings(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(path, readFileSync(tmp));
}

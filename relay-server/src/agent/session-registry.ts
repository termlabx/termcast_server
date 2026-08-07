import { readdirSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentSessionSummary } from './types.js';

export interface LiveSession {
  sessionId: string;
  cwd: string;
  transcriptPath: string;
  pid: number;
  /** Multiplexer pane holding the session, when known. */
  paneId: string | null;
}

export function liveSessionsDir(): string {
  return join(homedir(), '.ttyd-server', 'agent-sessions');
}

/** True when the pid still exists. Signal 0 tests without delivering anything. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Live sessions, filtered to those whose process still exists.
 *
 * A crashed agent never runs its SessionEnd hook, so the file outlives it. The
 * pid check is what keeps a dead session from wearing a live badge forever.
 */
export function readLiveSessions(dir: string = liveSessionsDir()): LiveSession[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }

  const live: LiveSession[] = [];
  for (const name of names) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Partial<LiveSession>;
      if (typeof raw.sessionId !== 'string' || typeof raw.pid !== 'number') continue;
      if (!pidAlive(raw.pid)) continue;
      live.push({
        sessionId: raw.sessionId,
        cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
        transcriptPath: typeof raw.transcriptPath === 'string' ? raw.transcriptPath : '',
        pid: raw.pid,
        paneId: typeof raw.paneId === 'string' ? raw.paneId : null,
      });
    } catch {
      // Corrupt or half-written entry; skip it.
    }
  }
  return live;
}

/** Atomic so a reader never observes a half-written entry. */
export function markLive(dir: string, entry: LiveSession): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${entry.sessionId}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
  renameSync(tmp, path);
}

export function clearLive(dir: string, sessionId: string): void {
  try {
    unlinkSync(join(dir, `${sessionId}.json`));
  } catch {
    // Already gone.
  }
}

export function applyLiveness(sessions: AgentSessionSummary[], live: LiveSession[]): AgentSessionSummary[] {
  const ids = new Set(live.map((entry) => entry.sessionId));
  return sessions.map((session) => (ids.has(session.id) ? { ...session, isLive: true } : session));
}

import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import type { AgentAdapter, AgentEvent, HistoryPage, PermissionBehavior, Unsubscribe } from './adapter.js';
import type { AgentSessionSummary } from './types.js';
import { discoverClaudeSessions, defaultProjectsRoot } from './claude-discovery.js';
import { readMessagesSince, TranscriptTail } from './claude-tail.js';
import { AgentUnsupportedError } from './opencode-adapter.js';

/**
 * Locate a session's transcript by scanning project directories.
 *
 * The directory name cannot be computed from a path (the encoding collapses
 * "/", "_" and "." onto "-"), so the file is found by its id instead.
 */
export async function transcriptPathFor(projectsRoot: string, sessionId: string): Promise<string | null> {
  let dirs: string[];
  try {
    dirs = (await readdir(projectsRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return null;
  }

  for (const dir of dirs) {
    try {
      const names = await readdir(join(projectsRoot, dir));
      if (names.includes(`${sessionId}.jsonl`)) return join(projectsRoot, dir, `${sessionId}.jsonl`);
    } catch {
      // Unreadable directory; keep looking.
    }
  }
  return null;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly kind = 'claude' as const;

  constructor(private readonly projectsRoot: string = defaultProjectsRoot()) {}

  list(): Promise<AgentSessionSummary[]> {
    return discoverClaudeSessions(this.projectsRoot);
  }

  async history(sessionId: string, beforeSeq: number | null, limit: number): Promise<HistoryPage> {
    const path = await transcriptPathFor(this.projectsRoot, sessionId);
    if (!path) return { messages: [], hasMore: false };

    const all = await readMessagesSince(path, -1);
    const end = beforeSeq === null ? all.length : all.findIndex((m) => m.seq === beforeSeq);
    const stop = end < 0 ? all.length : end;
    const start = Math.max(0, stop - limit);
    return { messages: all.slice(start, stop), hasMore: start > 0 };
  }

  async subscribe(sessionId: string, sinceSeq: number, onEvent: (event: AgentEvent) => void): Promise<Unsubscribe> {
    const path = await transcriptPathFor(this.projectsRoot, sessionId);
    if (!path) {
      onEvent({ kind: 'status', sessionId, seq: sinceSeq, status: 'ended', detail: 'transcript not found' });
      return () => {};
    }

    const tail = new TranscriptTail(path, sinceSeq, (message) => {
      onEvent({ kind: 'message', sessionId, seq: message.seq, message });
    });
    tail.start();
    return () => tail.stop();
  }

  async send(_sessionId: string, _text: string): Promise<void> {
    throw new AgentUnsupportedError('claude send');
  }

  async interrupt(_sessionId: string): Promise<void> {
    throw new AgentUnsupportedError('claude interrupt');
  }

  async respondPermission(_requestId: string, _behavior: PermissionBehavior): Promise<void> {
    throw new AgentUnsupportedError('claude permissions');
  }
}

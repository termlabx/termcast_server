import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import type { AgentAdapter, AgentEvent, HistoryPage, PermissionBehavior, Unsubscribe } from './adapter.js';
import type { AgentSessionSummary } from './types.js';
import { discoverClaudeSessions, defaultProjectsRoot } from './claude-discovery.js';
import { readMessagesSince, TranscriptTail } from './claude-tail.js';
import { ClaudeSdkSession } from './claude-sdk-session.js';

/** The slice of ClaudeSdkSession the adapter depends on, so tests can substitute it. */
export interface SdkSessionLike {
  start(): Promise<void>;
  send(text: string): void;
  stop(): void;
  onEvent(callback: (event: AgentEvent) => void): void;
  resolvePermission(requestId: string, behavior: PermissionBehavior): boolean;
}

export type SdkSessionFactory = (sessionId: string, cwd: string) => SdkSessionLike;

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

  private readonly sdkSessions = new Map<string, SdkSessionLike>();
  private sessionFactory: SdkSessionFactory =
    (sessionId, cwd) => new ClaudeSdkSession(sessionId, cwd);
  private eventSink: ((event: AgentEvent) => void) | null = null;

  /** Test seam. Production uses the default ClaudeSdkSession factory. */
  setSessionFactory(factory: SdkSessionFactory): void {
    this.sessionFactory = factory;
  }

  /** Where SDK-originated events go, since they have no transcript to tail. */
  setEventSink(sink: (event: AgentEvent) => void): void {
    this.eventSink = sink;
  }

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

  async send(sessionId: string, text: string): Promise<void> {
    let session = this.sdkSessions.get(sessionId);
    if (!session) {
      const path = await transcriptPathFor(this.projectsRoot, sessionId);
      if (!path) throw new Error(`unknown claude session: ${sessionId}`);

      const summaries = await this.list();
      const cwd = summaries.find((s) => s.id === sessionId)?.projectPath || process.cwd();

      session = this.sessionFactory(sessionId, cwd);
      session.onEvent((event) => this.eventSink?.(event));
      this.sdkSessions.set(sessionId, session);
      await session.start();
    }
    session.send(text);
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.sdkSessions.get(sessionId);
    if (!session) return;
    session.stop();
    this.sdkSessions.delete(sessionId);
  }

  async respondPermission(requestId: string, behavior: PermissionBehavior): Promise<void> {
    for (const session of this.sdkSessions.values()) {
      if (session.resolvePermission(requestId, behavior)) return;
    }
  }
}

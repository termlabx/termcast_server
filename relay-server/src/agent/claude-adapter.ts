import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import type { AgentAdapter, AgentEvent, HistoryPage, PermissionBehavior, Unsubscribe } from './adapter.js';
import type { AgentSessionSummary } from './types.js';
import { discoverClaudeSessions, defaultProjectsRoot } from './claude-discovery.js';
import { readMessagesSince, TranscriptTail } from './claude-tail.js';
import { ClaudeSdkSession } from './claude-sdk-session.js';
import { HerdrAgentCli } from './herdr-agent-cli.js';
import { SessionLiveness } from './session-liveness.js';
import { defaultDeskRegistry, isInjectable, type DeskRegistry, type DeskTarget } from './desk-target.js';
import { injectPrompt, waitUntilSettled } from './desk-inject.js';

/** The slice of ClaudeSdkSession the adapter depends on, so tests can substitute it. */
export interface SdkSessionLike {
  start(): Promise<void>;
  send(text: string): void;
  stop(): void;
  onEvent(callback: (event: AgentEvent) => void): void;
  resolvePermission(requestId: string, behavior: PermissionBehavior): boolean;
  resolveQuestion(requestId: string, answers?: string[], rejected?: boolean): boolean;
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

export interface ClaudeAdapterDeps {
  desk?: DeskRegistry;
  liveness?: SessionLiveness;
  cli?: HerdrAgentCli;
  inject?: (paneId: string, text: string, mux: 'herdr' | 'tmux') => Promise<void>;
  watchStatus?: (target: DeskTarget) => Promise<void>;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly kind = 'claude' as const;

  private readonly sdkSessions = new Map<string, SdkSessionLike>();
  private sessionFactory: SdkSessionFactory =
    (sessionId, cwd) => new ClaudeSdkSession(sessionId, cwd);
  private eventSink: ((event: AgentEvent) => void) | null = null;
  private transcriptLookup: (sessionId: string) => Promise<string | null> =
    (sessionId) => transcriptPathFor(this.projectsRoot, sessionId);

  private readonly desk: DeskRegistry;
  private readonly liveness: SessionLiveness;
  private readonly inject: (paneId: string, text: string, mux: 'herdr' | 'tmux') => Promise<void>;
  private readonly watchStatus: (target: DeskTarget) => Promise<void>;

  constructor(
    private readonly projectsRoot: string = defaultProjectsRoot(),
    deps: ClaudeAdapterDeps = {},
  ) {
    const cli = deps.cli ?? new HerdrAgentCli();
    this.desk = deps.desk ?? defaultDeskRegistry();
    this.liveness = deps.liveness ?? new SessionLiveness();
    this.inject = deps.inject ?? ((paneId, text, mux) => injectPrompt(cli, paneId, text, mux));
    this.watchStatus = deps.watchStatus ?? ((target) => waitUntilSettled(cli, target));
  }

  /** Test seam. Production uses the default ClaudeSdkSession factory. */
  setSessionFactory(factory: SdkSessionFactory): void {
    this.sessionFactory = factory;
  }

  /** Test seam. Production scans the projects root for the transcript. */
  setTranscriptLookup(lookup: (sessionId: string) => Promise<string | null>): void {
    this.transcriptLookup = lookup;
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
    const target = await this.desk.lookup('claude', sessionId);

    // A session that is reachable belongs to whoever is at the desk: drive the
    // real pane rather than starting a second agent against the same repo.
    if (target) {
      if (!isInjectable(target.status)) {
        throw new Error('That session is busy at the desk — it is still working or waiting on you.');
      }
      await this.inject(target.paneId, text, target.mux);
      // The transcript tail streams the reply but never announces the end of a
      // turn, so the phone's Working indicator would stick forever. Whatever
      // raised turn_start owns emitting the end.
      void this.watchUntilSettled(sessionId, target);
      return;
    }

    // Unreachable but running: refusing is the point of this path. A headless
    // resume here would answer on the phone while the terminal the user is
    // looking at shows nothing, and the two contexts would diverge.
    const summaries = await this.list();
    const summary = summaries.find((s) => s.id === sessionId);
    if (await this.liveness.isAlive('claude', sessionId, summary?.projectPath ?? '')) {
      throw new Error(
        'That session is open in a terminal on your Mac that cannot be mirrored. ' +
        'Reopen it inside your multiplexer to chat from here.',
      );
    }

    let session = this.sdkSessions.get(sessionId);
    if (!session) {
      const path = await this.transcriptLookup(sessionId);
      if (!path) throw new Error(`unknown claude session: ${sessionId}`);

      const cwd = summary?.projectPath || process.cwd();
      session = this.sessionFactory(sessionId, cwd);
      session.onEvent((event) => this.eventSink?.(event));
      this.sdkSessions.set(sessionId, session);
      await session.start();
    }
    session.send(text);
  }

  private async watchUntilSettled(sessionId: string, target: DeskTarget): Promise<void> {
    try {
      await this.watchStatus(target);
    } catch {
      // Multiplexer gone or unreadable — end the turn rather than leave the
      // phone stuck on Working.
    }
    this.eventSink?.({ kind: 'status', sessionId, seq: -1, status: 'turn_end' });
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

  async respondQuestion(requestId: string, answers?: string[], rejected?: boolean): Promise<void> {
    for (const session of this.sdkSessions.values()) {
      if (session.resolveQuestion(requestId, answers, rejected)) return;
    }
  }
}

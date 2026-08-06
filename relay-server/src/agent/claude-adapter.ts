import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentAdapter, AgentEvent, HistoryPage, PermissionBehavior, Unsubscribe } from './adapter.js';
import type { AgentSessionSummary } from './types.js';
import { discoverClaudeSessions, defaultProjectsRoot } from './claude-discovery.js';
import { readMessagesSince, TranscriptTail } from './claude-tail.js';
import { ClaudeSdkSession } from './claude-sdk-session.js';
import { readLiveSessions, type LiveSession } from './session-registry.js';
import { sendKeysCommand } from '../multiplexer.js';

const run = promisify(exec);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface IdleWaitOptions {
  settleMs?: number;
  pollMs?: number;
  timeoutMs?: number;
}

/**
 * Resolves once the pane has read idle on two consecutive samples, so a brief
 * non-idle blink cannot end a turn early. Bounded so a session abandoned
 * mid-turn cannot leave a watcher running forever.
 */
export async function waitForIdle(
  sampleIdle: () => Promise<boolean>,
  opts: IdleWaitOptions = {},
): Promise<void> {
  const settleMs = opts.settleMs ?? 2000;
  const pollMs = opts.pollMs ?? 800;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  await sleep(settleMs);
  let idleStreak = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const idle = await sampleIdle();
    idleStreak = idle ? idleStreak + 1 : 0;
    if (idleStreak >= 2) return;
    await sleep(pollMs);
  }
}

/** Returns false when the pane already has typed input we would interleave with. */
export async function paneIsIdle(paneId: string): Promise<boolean> {
  try {
    const { stdout } = await run(`tmux display-message -p -t '${paneId.replace(/'/g, '')}' '#{pane_in_mode}:#{cursor_x}'`);
    const [inMode, cursorX] = stdout.trim().split(':');
    // A non-zero cursor column means a partially typed line is sitting there.
    return inMode === '0' && cursorX === '0';
  } catch {
    // Cannot tell — assume idle rather than blocking the phone entirely.
    return true;
  }
}

export type Injector = (paneId: string, text: string) => Promise<boolean>;
export type LiveLookup = () => LiveSession[];
export type IdleSampler = (paneId: string) => Promise<boolean>;

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

export class ClaudeAdapter implements AgentAdapter {
  readonly kind = 'claude' as const;

  constructor(private readonly projectsRoot: string = defaultProjectsRoot()) {}

  private readonly sdkSessions = new Map<string, SdkSessionLike>();
  private sessionFactory: SdkSessionFactory =
    (sessionId, cwd) => new ClaudeSdkSession(sessionId, cwd);
  private eventSink: ((event: AgentEvent) => void) | null = null;
  private liveLookup: LiveLookup = () => readLiveSessions();
  private idleWaiter: (sample: () => Promise<boolean>, opts?: IdleWaitOptions) => Promise<void> = waitForIdle;
  private idleSampler: IdleSampler = (paneId) => paneIsIdle(paneId);
  private injector: Injector = async (paneId, text) => {
    if (!(await paneIsIdle(paneId))) return false;
    const command = sendKeysCommand(paneId, text, 'tmux');
    if (!command) return false;
    await run(command);
    return true;
  };

  /** Test seam. Production uses the default ClaudeSdkSession factory. */
  setSessionFactory(factory: SdkSessionFactory): void {
    this.sessionFactory = factory;
  }

  /** Test seam. Production uses the real session registry. */
  setLiveLookup(lookup: LiveLookup): void {
    this.liveLookup = lookup;
  }

  /** Test seam. Production injects into tmux with an idle-input guard. */
  setInjector(injector: Injector): void {
    this.injector = injector;
  }

  /** Test seam. Production waits on the real tmux pane state. */
  setIdleWaiter(waiter: (sample: () => Promise<boolean>, opts?: IdleWaitOptions) => Promise<void>): void {
    this.idleWaiter = waiter;
  }

  /** Test seam. Production probes the real tmux pane. */
  setIdleSampler(sampler: IdleSampler): void {
    this.idleSampler = sampler;
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
    const live = this.liveLookup().find((entry) => entry.sessionId === sessionId);

    // A live session belongs to whoever is sitting at the desk: drive the real
    // pane rather than starting a second agent against the same repo.
    if (live?.paneId) {
      const delivered = await this.injector(live.paneId, text);
      if (!delivered) throw new Error('That session is busy at the desk — someone is typing in it.');
      // The transcript tail streams the reply, but it never announces the end of
      // a turn — the phone's "Working" indicator would stick forever. Emit
      // turn_end once the pane returns to idle (Claude Code back at its prompt).
      void this.watchUntilIdle(sessionId, live.paneId);
      return;
    }

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

  private async watchUntilIdle(sessionId: string, paneId: string): Promise<void> {
    const turnEnd = (): void => {
      this.eventSink?.({ kind: 'status', sessionId, seq: -1, status: 'turn_end' });
    };
    try {
      await this.idleWaiter(() => this.idleSampler(paneId));
      turnEnd();
    } catch {
      // tmux gone or unreadable — end the turn rather than leave the phone stuck.
      turnEnd();
    }
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

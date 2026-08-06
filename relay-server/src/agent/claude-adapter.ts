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
import { HerdrAgentCli } from './herdr-agent-cli.js';
import { SessionLiveness } from './session-liveness.js';
import { deskRegistryFor, isInjectable, type DeskRegistry, type DeskTarget } from './desk-target.js';
import { activeMultiplexer } from '../multiplexer.js';
import { injectPrompt, waitUntilSettled } from './desk-inject.js';

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

/** One reading of a pane: whether it is in copy mode, and what it is showing. */
export type PaneProbe = (paneId: string) => Promise<{ inMode: boolean; content: string } | null>;

const tmuxProbe: PaneProbe = async (paneId) => {
  const id = paneId.replace(/'/g, '');
  try {
    const [mode, content] = await Promise.all([
      run(`tmux display-message -p -t '${id}' '#{pane_in_mode}'`),
      run(`tmux capture-pane -p -t '${id}'`),
    ]);
    return { inMode: mode.stdout.trim() !== '0', content: content.stdout };
  } catch {
    return null;
  }
};

/**
 * Whether the pane has settled — nothing repainting, no scrollback view open.
 *
 * Two captures a beat apart: a working agent animates a spinner and streams
 * tokens, so its pane differs between them, while a pane parked at its prompt
 * is byte-identical. This deliberately does not look at the cursor column. A
 * TUI parks its cursor inside an input box (a real pane here read `cursor_x=38`
 * while working and `11` while idle), so the old `cursor_x == 0` test read
 * "busy" for every agent pane in existence: sends were refused as "busy at the
 * desk" and turn_end only fired at the 10-minute bound, which is what left the
 * phone showing "Working…" indefinitely.
 */
export async function paneIsIdle(
  paneId: string,
  probe: PaneProbe = tmuxProbe,
  gapMs = 400,
): Promise<boolean> {
  const first = await probe(paneId);
  // Cannot tell — assume idle rather than blocking the phone entirely.
  if (!first) return true;
  if (first.inMode) return false;
  await sleep(gapMs);
  const second = await probe(paneId);
  if (!second) return true;
  return !second.inMode && second.content === first.content;
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
    this.desk = deps.desk ?? deskRegistryFor(activeMultiplexer());
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

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveMultiplexerBinary } from '../multiplexer.js';

const execFileAsync = promisify(execFile);

/** Bounded so a wedged herdr server cannot stall a phone's send indefinitely. */
export const HERDR_TIMEOUT_MS = 10_000;

/**
 * How long herdr may take to observe a submitted prompt starting a turn.
 *
 * Above herdr's own 5 s stall window, because a shorter `--timeout` makes it
 * answer `timeout` instead of `agent_prompt_stalled` and we lose the
 * distinction between "never submitted" and "we gave up early". Below
 * HERDR_TIMEOUT_MS, because execFile firing first would kill the process
 * mid-answer and turn a clean rejection into an unparseable one.
 */
export const PROMPT_CONFIRM_TIMEOUT_MS = 8_000;

export interface PromptOptions {
  /**
   * Wait for herdr to observe the turn actually start, and reject when it does
   * not. Without it a prompt herdr typed but never submitted still answers
   * `agent_prompted`, so the caller reports a delivered message that is sitting
   * unsent in the user's input box.
   */
  confirmStart?: boolean;
}

export type HerdrStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

const STATUSES: readonly string[] = ['idle', 'working', 'blocked', 'done', 'unknown'];

export interface HerdrAgent {
  /** herdr's own name for the agent; callers map it onto AgentKind. */
  agent: string;
  /** Null when herdr detected an agent but could not identify its session. */
  sessionId: string | null;
  status: HerdrStatus;
  paneId: string;
  cwd: string;
  /**
   * herdr's monotonic counter for this pane's state changes. Null when herdr
   * did not report one — absent rather than 0, because the desk-question race
   * guard compares it for equality and a missing counter must not read as a
   * real one that happens to match.
   */
  stateChangeSeq: number | null;
}

/** Test seam: argv in, captured output out. Production runs the real binary. */
export type HerdrRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

/**
 * The herdr binary to spawn.
 *
 * Never a bare 'herdr': the daemon is started by the desktop app, whose PATH is
 * the bare login set (/usr/local/bin:/opt/homebrew/bin:/usr/bin:...) and does
 * not include ~/.termcast/bin or ~/.local/bin, where the installers put it.
 * Relying on PATH there is ENOENT, which made every herdr-hosted session
 * unreachable while tmux — which happens to sit on /opt/homebrew/bin — worked.
 *
 * Resolved per call, not once at import, so installing herdr mid-session takes
 * effect without a restart.
 */
export function herdrCommand(
  resolve: (mux: 'tmux' | 'herdr') => string | null = resolveMultiplexerBinary,
): string {
  return resolve('herdr') ?? 'herdr';
}

const defaultRunner: HerdrRunner = (args) =>
  execFileAsync(herdrCommand(), args, { timeout: HERDR_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });

/**
 * Thin typed shell over `herdr agent`.
 *
 * execFile, not exec: prompt text is arbitrary user input arriving from a
 * phone, and passing it through a shell would make every send an injection
 * site. argv entries are handed to the binary untouched.
 *
 * herdr reports failures as a JSON `error` object on stdout and still exits 0,
 * so a non-throwing run is not a success — the payload has to be inspected.
 */
export class HerdrAgentCli {
  constructor(private readonly runner: HerdrRunner = defaultRunner) {}

  async list(): Promise<HerdrAgent[]> {
    const body = await this.run(['agent', 'list']);
    if (!body || body.error) return [];
    const agents = (body.result as { agents?: unknown } | undefined)?.agents;
    if (!Array.isArray(agents)) return [];
    return agents.map(parseAgent).filter((a): a is HerdrAgent => a !== null);
  }

  async get(paneId: string): Promise<HerdrAgent | null> {
    const body = await this.run(['agent', 'get', paneId]);
    if (!body || body.error) return null;
    return parseAgent((body.result as { agent?: unknown } | undefined)?.agent);
  }

  /**
   * Types `text` into the agent's pane and submits it. Rejects when herdr
   * refuses, and — with `confirmStart` — when the prompt went in but no turn
   * ever began.
   *
   * `working`/`blocked` rather than herdr's default idle/done: waiting for a
   * settled state reports a legitimately long turn as a failed send, which is
   * the whole reason `--wait` was avoided here originally. A turn *starting* is
   * bounded; a turn *finishing* is not.
   *
   * `blocked` is in there because a prompt can land straight on a dialog — a
   * `/model` sent from the phone never passes through `working` — and that is a
   * submission that took effect. `done` is deliberately absent: the agent is
   * often already `done` from the previous turn, so matching it risks reading a
   * stale state as a fresh acknowledgement.
   */
  async prompt(paneId: string, text: string, opts: PromptOptions = {}): Promise<void> {
    const args = ['agent', 'prompt', paneId, text];
    if (opts.confirmStart) {
      args.push(
        '--wait', '--until', 'working', '--until', 'blocked',
        '--timeout', String(PROMPT_CONFIRM_TIMEOUT_MS),
      );
    }
    const body = await this.run(args);
    if (!body) throw new Error('herdr agent prompt produced no parseable response');
    if (body.error) {
      const err = body.error as { code?: unknown; message?: unknown };
      throw new Error(`herdr ${String(err.code ?? 'error')}: ${String(err.message ?? 'unknown')}`);
    }
  }

  /**
   * The pane exactly as it is drawn right now.
   *
   * `visible` only, never `recent`: scrollback holds dialogs that were already
   * answered, and parsing one of those would offer the phone a question that no
   * longer exists.
   *
   * The one subcommand whose *success* output is not JSON — it prints the
   * rendered text — so a payload that parses as an error object is the failure
   * case and anything else is the pane.
   */
  async read(paneId: string): Promise<string | null> {
    let stdout: string;
    try {
      ({ stdout } = await this.runner(['agent', 'read', paneId, '--source', 'visible']));
    } catch {
      return null;
    }
    try {
      const body = JSON.parse(stdout) as { error?: unknown };
      if (body && typeof body === 'object' && body.error) return null;
    } catch {
      // Not JSON, which is what a successfully read pane looks like.
    }
    return stdout;
  }

  /**
   * Press keys in the pane. `esc` is herdr's canonical Escape name.
   *
   * An unparseable answer is deliberately not a refusal: callers confirm the
   * dialog actually closed by re-reading the pane, so treating an odd-but-silent
   * response as fatal would reject sends that in fact took effect.
   */
  async sendKeys(paneId: string, keys: readonly string[]): Promise<void> {
    const body = await this.run(['agent', 'send-keys', paneId, ...keys]);
    if (body?.error) {
      const err = body.error as { code?: unknown; message?: unknown };
      throw new Error(`herdr ${String(err.code ?? 'error')}: ${String(err.message ?? 'unknown')}`);
    }
  }

  /**
   * Block until the pane reaches one of `until`.
   *
   * Null on timeout or failure. herdr reports its own timeout as an error
   * object, and a caller that could not tell "settled" from "gave up" would
   * report an unanswered dialog as answered.
   */
  async wait(paneId: string, until: readonly HerdrStatus[], timeoutMs: number): Promise<HerdrAgent | null> {
    const args = ['agent', 'wait', paneId];
    for (const status of until) args.push('--until', status);
    args.push('--timeout', String(timeoutMs));

    const body = await this.run(args);
    if (!body || body.error) return null;
    return parseAgent((body.result as { agent?: unknown } | undefined)?.agent);
  }

  /** Null when herdr is absent, times out, or prints something that is not JSON. */
  private async run(args: string[]): Promise<{ error?: unknown; result?: unknown } | null> {
    try {
      const { stdout } = await this.runner(args);
      return JSON.parse(stdout) as { error?: unknown; result?: unknown };
    } catch {
      return null;
    }
  }
}

function parseAgent(raw: unknown): HerdrAgent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const paneId = typeof r.pane_id === 'string' ? r.pane_id : null;
  const agent = typeof r.agent === 'string' ? r.agent : null;
  if (!paneId || !agent) return null;

  const session = r.agent_session as Record<string, unknown> | undefined;
  // Only kind 'id' carries a real session id; 'title' and friends are a
  // detected-but-unidentified agent, which cannot be routed to.
  const sessionId =
    session?.kind === 'id' && typeof session.value === 'string' ? session.value : null;

  const status = typeof r.agent_status === 'string' && STATUSES.includes(r.agent_status)
    ? (r.agent_status as HerdrStatus)
    : 'unknown';

  return {
    agent, sessionId, status, paneId,
    cwd: typeof r.cwd === 'string' ? r.cwd : '',
    stateChangeSeq: typeof r.state_change_seq === 'number' ? r.state_change_seq : null,
  };
}

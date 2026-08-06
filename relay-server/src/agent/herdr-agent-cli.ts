import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Bounded so a wedged herdr server cannot stall a phone's send indefinitely. */
const HERDR_TIMEOUT_MS = 10_000;

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
}

/** Test seam: argv in, captured output out. Production runs the real binary. */
export type HerdrRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: HerdrRunner = (args) =>
  execFileAsync('herdr', args, { timeout: HERDR_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });

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

  /** Types `text` into the agent's pane and submits it. Rejects when herdr refuses. */
  async prompt(paneId: string, text: string): Promise<void> {
    const body = await this.run(['agent', 'prompt', paneId, text]);
    if (!body) throw new Error('herdr agent prompt produced no parseable response');
    if (body.error) {
      const err = body.error as { code?: unknown; message?: unknown };
      throw new Error(`herdr ${String(err.code ?? 'error')}: ${String(err.message ?? 'unknown')}`);
    }
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

  return { agent, sessionId, status, paneId, cwd: typeof r.cwd === 'string' ? r.cwd : '' };
}

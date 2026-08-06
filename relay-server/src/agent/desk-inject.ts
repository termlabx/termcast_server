import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { sendKeysCommand } from '../multiplexer.js';
import type { HerdrAgentCli } from './herdr-agent-cli.js';
import type { DeskTarget } from './desk-target.js';
import { isInjectable } from './desk-target.js';

const run = promisify(exec);

/** Matches waitForIdle's old bound: a turn may legitimately run for a long time. */
const SETTLE_TIMEOUT_MS = 10 * 60_000;
const SETTLE_POLL_MS = 800;
/** herdr needs a beat to move an agent out of idle after a prompt lands. */
const SETTLE_GRACE_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Type `text` into a pane and submit it. Throws when the multiplexer refuses. */
export async function injectPrompt(
  cli: HerdrAgentCli, paneId: string, text: string, mux: 'herdr' | 'tmux',
): Promise<void> {
  if (mux === 'herdr') {
    await cli.prompt(paneId, text);
    return;
  }
  const command = sendKeysCommand(paneId, text, 'tmux');
  if (!command) throw new Error('nothing to send');
  await run(command);
}

/**
 * Resolve once the agent has left `working`.
 *
 * Submission and waiting are separate calls on purpose: `herdr agent prompt
 * --wait --until idle` returns `timeout` while an agent is legitimately working
 * — a provider retry backoff kept one in `working` for hours during design —
 * which would report a delivered prompt as a failed send.
 *
 * tmux reports no status, so there is nothing to poll; the caller ends the turn
 * immediately rather than blocking on a signal that will never arrive.
 */
export async function waitUntilSettled(cli: HerdrAgentCli, target: DeskTarget): Promise<void> {
  if (target.mux !== 'herdr') return;
  await sleep(SETTLE_GRACE_MS);
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const agent = await cli.get(target.paneId);
    if (!agent) return;
    if (isInjectable(agent.status)) return;
    await sleep(SETTLE_POLL_MS);
  }
}

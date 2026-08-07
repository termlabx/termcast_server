import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { sendKeysCommand } from '../multiplexer.js';
import type { HerdrAgentCli } from './herdr-agent-cli.js';
import type { DeskTarget } from './desk-target.js';
import { isInjectable } from './desk-target.js';

const run = promisify(exec);

/** A turn may legitimately run for a long time; this only bounds the watcher. */
const SETTLE_TIMEOUT_MS = 10 * 60_000;
const SETTLE_POLL_MS = 800;
/** herdr needs a beat to move an agent out of idle after a prompt lands. */
const SETTLE_GRACE_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Type `text` into a pane and submit it. Throws when the multiplexer refuses,
 * and — under herdr — when the text went in but no turn ever started.
 *
 * That second case is not hypothetical: herdr answers `agent_prompted` for a
 * prompt it typed into the pane and failed to submit, so two phone sends two
 * minutes apart were once found concatenated in a single unsubmitted input box
 * ("he'llhello"). Treating acceptance as delivery is what let the caller report
 * a completed turn for a message that never ran.
 *
 * `exec` is a test seam; production runs the real shell.
 */
export async function injectPrompt(
  cli: HerdrAgentCli, paneId: string, text: string, mux: 'herdr' | 'tmux',
  exec: (command: string) => Promise<unknown> = run,
): Promise<void> {
  if (mux === 'herdr') {
    try {
      await cli.prompt(paneId, text, { confirmStart: true });
    } catch (err) {
      // herdr's own codes (agent_prompt_stalled, timeout) reach the phone
      // verbatim as the whole explanation, so they are translated here.
      throw new Error(
        'The message reached the session at your desk but was not submitted — ' +
        'no turn started. It may still be sitting in the input box there.',
        { cause: err },
      );
    }
    return;
  }
  const command = sendKeysCommand(paneId, text, 'tmux');
  if (!command) throw new Error('nothing to send');
  await exec(command);
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

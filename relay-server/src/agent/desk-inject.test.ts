import { test } from 'node:test';
import assert from 'node:assert/strict';
import { injectPrompt } from './desk-inject.js';
import type { HerdrAgentCli, PromptOptions } from './herdr-agent-cli.js';

/** Only the slice of HerdrAgentCli that injectPrompt touches. */
function fakeCli(prompt: (paneId: string, text: string, opts?: PromptOptions) => Promise<void>): HerdrAgentCli {
  return { prompt } as unknown as HerdrAgentCli;
}

test('herdr: asks for the submission to be confirmed, not just accepted', async () => {
  const calls: Array<{ paneId: string; text: string; opts?: PromptOptions }> = [];
  const cli = fakeCli(async (paneId, text, opts) => { calls.push({ paneId, text, opts }); });

  await injectPrompt(cli, 'wB:p1', 'hello', 'herdr');

  assert.deepEqual(calls, [{ paneId: 'wB:p1', text: 'hello', opts: { confirmStart: true } }]);
});

// The reported bug. herdr answered `agent_prompted` for a prompt it had typed
// into the pane but never submitted; two sends two minutes apart ended up
// concatenated in one input box as "he'llhello". Resolving here is what let the
// caller emit turn_end for a message that never ran.
test('herdr: a prompt that never started a turn rejects', async () => {
  const cli = fakeCli(async () => { throw new Error('herdr agent_prompt_stalled: no state change'); });

  await assert.rejects(() => injectPrompt(cli, 'wB:p1', 'hello', 'herdr'));
});

test('herdr: the rejection explains the failure in the phone user\'s terms', async () => {
  // agent_send forwards this verbatim to the phone as a status:error detail, so
  // a raw herdr error code would surface as the entire explanation.
  const cli = fakeCli(async () => { throw new Error('herdr agent_prompt_stalled: no state change'); });

  await assert.rejects(
    () => injectPrompt(cli, 'wB:p1', 'hello', 'herdr'),
    (err: Error) => {
      assert.match(err.message, /not submitted|never submitted/i);
      assert.doesNotMatch(err.message, /agent_prompt_stalled/);
      return true;
    },
  );
});

test('herdr: a confirmed submission resolves', async () => {
  const cli = fakeCli(async () => {});
  await assert.doesNotReject(() => injectPrompt(cli, 'wB:p1', 'hello', 'herdr'));
});

// tmux reports no agent status at all, so there is nothing to confirm against.
// The gap is honest and pre-existing; inventing a confirmation here would mean
// inventing the signal too.
test('tmux: still literal text followed by a separate Enter, with no confirmation', async () => {
  const commands: string[] = [];
  const cli = fakeCli(async () => { throw new Error('herdr must not be consulted for tmux'); });

  await injectPrompt(cli, '%12', 'hello', 'tmux', async (command) => { commands.push(command); });

  assert.equal(commands.length, 1);
  assert.match(commands[0], /send-keys -t '%12' -l 'hello'/);
  assert.match(commands[0], /&& .*send-keys -t '%12' Enter/);
});

test('tmux: refuses text the multiplexer cannot send rather than reporting success', async () => {
  const cli = fakeCli(async () => {});
  await assert.rejects(() => injectPrompt(cli, '%12', '   ', 'tmux', async () => {}), /nothing to send/);
});

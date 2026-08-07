import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HerdrAgentCli, herdrCommand, HERDR_TIMEOUT_MS, PROMPT_CONFIRM_TIMEOUT_MS,
  type HerdrRunner,
} from './herdr-agent-cli.js';

/** Verbatim shape from `herdr agent list` on herdr 0.7.5, trimmed to three agents. */
const LIST_FIXTURE = JSON.stringify({
  id: 'cli:agent:list',
  result: {
    type: 'agent_list',
    agents: [
      {
        agent: 'claude',
        agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: 'a0be98b6-5e09-4844-833c-1f3e19172aae' },
        agent_status: 'idle',
        cwd: '/Users/x/Projects/speech_cursor',
        pane_id: 'w3:p2',
        state_change_seq: 135,
        tab_id: 'w3:t2',
        workspace_id: 'w3',
      },
      {
        agent: 'opencode',
        agent_session: { agent: 'opencode', kind: 'id', source: 'herdr:opencode', value: 'ses_02fb8e1c2ffeV02NFdHFFfRsSR' },
        agent_status: 'working',
        cwd: '/Users/x/Projects/holiscord2',
        pane_id: 'w3:p1',
        tab_id: 'w3:t1',
        workspace_id: 'w3',
      },
      {
        agent: 'opencode',
        agent_session: { agent: 'opencode', kind: 'title', source: 'herdr:opencode', value: 'Some window title' },
        agent_status: 'idle',
        cwd: '/Users/x/Projects/other',
        pane_id: 'w4:p1',
        tab_id: 'w4:t1',
        workspace_id: 'w4',
      },
    ],
  },
});

const runnerFor = (stdout: string): HerdrRunner => async () => ({ stdout, stderr: '' });

test('list: parses agents into session id, status and pane', async () => {
  const cli = new HerdrAgentCli(runnerFor(LIST_FIXTURE));
  const agents = await cli.list();

  assert.equal(agents.length, 3);
  assert.deepEqual(agents[0], {
    agent: 'claude',
    sessionId: 'a0be98b6-5e09-4844-833c-1f3e19172aae',
    status: 'idle',
    paneId: 'w3:p2',
    cwd: '/Users/x/Projects/speech_cursor',
    stateChangeSeq: 135,
  });
  assert.equal(agents[1].status, 'working');
  assert.equal(agents[1].paneId, 'w3:p1');
  // Absent in the fixture, and absent rather than 0 — the race guard compares
  // it for equality, and a missing counter must not read as a real one.
  assert.equal(agents[1].stateChangeSeq, null);
});

test('list: an agent_session that is not kind=id has no usable session id', async () => {
  const cli = new HerdrAgentCli(runnerFor(LIST_FIXTURE));
  const agents = await cli.list();
  assert.equal(agents[2].sessionId, null);
});

test('list: an unknown agent_status degrades to unknown rather than throwing', async () => {
  const body = JSON.stringify({
    id: 'cli:agent:list',
    result: { type: 'agent_list', agents: [{
      agent: 'claude',
      agent_session: { kind: 'id', value: 's1' },
      agent_status: 'compacting',
      cwd: '/tmp', pane_id: 'w1:p1',
    }] },
  });
  const agents = await new HerdrAgentCli(runnerFor(body)).list();
  assert.equal(agents[0].status, 'unknown');
});

test('list: a herdr error payload yields no agents instead of throwing', async () => {
  const body = JSON.stringify({ error: { code: 'server_unavailable', message: 'no server' }, id: 'cli:agent:list' });
  assert.deepEqual(await new HerdrAgentCli(runnerFor(body)).list(), []);
});

test('list: unparseable output yields no agents', async () => {
  assert.deepEqual(await new HerdrAgentCli(runnerFor('herdr: command not found')).list(), []);
});

test('list: a runner that throws yields no agents', async () => {
  const cli = new HerdrAgentCli(async () => { throw new Error('ENOENT'); });
  assert.deepEqual(await cli.list(), []);
});

test('get: returns null on the agent_not_found error payload', async () => {
  const body = JSON.stringify({ error: { code: 'agent_not_found', message: 'agent target w9:p9 not found' }, id: 'cli:agent:get' });
  assert.equal(await new HerdrAgentCli(runnerFor(body)).get('w9:p9'), null);
});

test('prompt: passes pane and text as separate argv entries, never a shell string', async () => {
  const calls: string[][] = [];
  const cli = new HerdrAgentCli(async (args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ id: 'cli:agent:prompt', result: { type: 'ok' } }), stderr: '' };
  });

  await cli.prompt('w3:p2', "it's; rm -rf / $(whoami)");

  assert.deepEqual(calls, [['agent', 'prompt', 'w3:p2', "it's; rm -rf / $(whoami)"]]);
});

test('prompt: a herdr error payload rejects with its message', async () => {
  const body = JSON.stringify({ error: { code: 'agent_prompt_stalled', message: 'agent did not change state' }, id: 'cli:agent:prompt' });
  const cli = new HerdrAgentCli(runnerFor(body));
  await assert.rejects(() => cli.prompt('w3:p2', 'hi'), /agent_prompt_stalled/);
});

// Without this, a prompt that herdr typed into the pane but never submitted is
// indistinguishable from one that ran: herdr answers `agent_prompted` either
// way. Two phone sends landing in one unsubmitted input box ("he'llhello") is
// what that looks like on the desk.
test('prompt: confirmStart asks herdr to observe the turn actually start', async () => {
  const calls: string[][] = [];
  const cli = new HerdrAgentCli(async (args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ id: 'cli:agent:prompt', result: { type: 'ok' } }), stderr: '' };
  });

  await cli.prompt('w3:p2', 'hi', { confirmStart: true });

  assert.deepEqual(calls, [[
    'agent', 'prompt', 'w3:p2', 'hi',
    '--wait', '--until', 'working', '--until', 'blocked',
    '--timeout', String(PROMPT_CONFIRM_TIMEOUT_MS),
  ]]);
});

// A prompt can land straight on a dialog without passing through `working` —
// a `/model` sent from the phone does exactly that — and that is a submission
// that took effect, not a stall.
test('prompt: a submission that lands on a dialog counts as started', async () => {
  const calls: string[][] = [];
  const cli = new HerdrAgentCli(async (args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ id: 'cli:agent:prompt', result: { type: 'ok' } }), stderr: '' };
  });

  await cli.prompt('w3:p2', '/model', { confirmStart: true });

  assert.ok(calls[0].includes('blocked'), 'blocked must be an accepted outcome');
  assert.ok(!calls[0].includes('done'), 'done is often stale from the previous turn');
});

// `working` rather than idle/done on purpose: waiting for a settled state
// reports a legitimately long turn as a failed send, which is why --wait was
// avoided in the first place. Starting is bounded; finishing is not.
test('prompt: the confirmation window outlasts herdr stall detection but not our own timeout', async () => {
  assert.ok(PROMPT_CONFIRM_TIMEOUT_MS > 5_000, 'a shorter window makes herdr answer `timeout`, losing the stall signal');
  assert.ok(PROMPT_CONFIRM_TIMEOUT_MS < HERDR_TIMEOUT_MS, 'execFile must never be the thing that fires first');
});

test('prompt: a stalled submission rejects rather than reporting success', async () => {
  const body = JSON.stringify({ error: { code: 'agent_prompt_stalled', message: 'no state change' }, id: 'cli:agent:prompt' });
  const cli = new HerdrAgentCli(runnerFor(body));
  await assert.rejects(() => cli.prompt('w3:p2', 'hi', { confirmStart: true }), /agent_prompt_stalled/);
});

test('prompt: a confirmation timeout rejects too', async () => {
  const body = JSON.stringify({ error: { code: 'timeout', message: 'deadline exceeded' }, id: 'cli:agent:prompt' });
  const cli = new HerdrAgentCli(runnerFor(body));
  await assert.rejects(() => cli.prompt('w3:p2', 'hi', { confirmStart: true }), /timeout/);
});

// The daemon is launched by the desktop app, whose PATH is the bare login set:
// /usr/local/bin:/opt/homebrew/bin:/usr/bin:... It does NOT include
// ~/.termcast/bin or ~/.local/bin, where the herdr installers put the binary.
// Spawning bare 'herdr' there is ENOENT, which surfaced as every herdr-hosted
// session being unreachable while tmux (on /opt/homebrew/bin) worked.
test('herdrCommand: prefers the resolved binary over a bare PATH lookup', () => {
  assert.equal(
    herdrCommand(() => '/Users/x/.termcast/bin/herdr'),
    '/Users/x/.termcast/bin/herdr',
  );
});

test('herdrCommand: falls back to the PATH name when nothing resolves', () => {
  // Better a PATH lookup that might work than a guaranteed ENOENT on a path
  // we invented.
  assert.equal(herdrCommand(() => null), 'herdr');
});

// `read` is the one subcommand whose *success* output is not JSON: it prints
// the rendered pane. Failures still come back as a JSON error object.
test('read: returns the rendered pane text from --source visible', async () => {
  const calls: string[][] = [];
  const cli = new HerdrAgentCli(async (args) => {
    calls.push(args);
    return { stdout: '  ❯ 1. Yes\n  Enter to confirm · Esc to cancel\n', stderr: '' };
  });

  assert.match((await cli.read('w3:p2'))!, /Enter to confirm/);
  // `recent` would hand back scrollback, which holds dialogs that were already
  // answered; offering one of those is a question that no longer exists.
  assert.deepEqual(calls[0], ['agent', 'read', 'w3:p2', '--source', 'visible']);
});

test('read: a herdr error payload reads as no pane rather than as pane text', async () => {
  const body = JSON.stringify({ error: { code: 'agent_not_found', message: 'nope' }, id: 'cli:agent:read' });
  assert.equal(await new HerdrAgentCli(runnerFor(body)).read('nope'), null);
});

test('read: a spawn failure yields null', async () => {
  const cli = new HerdrAgentCli(async () => { throw new Error('ENOENT'); });
  assert.equal(await cli.read('w3:p2'), null);
});

test('sendKeys: passes every key as its own argv entry', async () => {
  const calls: string[][] = [];
  const cli = new HerdrAgentCli(async (args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ id: 'cli:agent:send-keys', result: {} }), stderr: '' };
  });

  await cli.sendKeys('w3:p2', ['down', 'down', 'enter']);
  assert.deepEqual(calls[0], ['agent', 'send-keys', 'w3:p2', 'down', 'down', 'enter']);
});

test('sendKeys: throws on a herdr error payload', async () => {
  const body = JSON.stringify({ error: { code: 'agent_not_found', message: 'nope' }, id: 'cli:agent:send-keys' });
  await assert.rejects(() => new HerdrAgentCli(runnerFor(body)).sendKeys('w3:p2', ['esc']), /agent_not_found/);
});

test('sendKeys: an unparseable answer is not treated as a refusal', async () => {
  // Callers confirm the dialog actually closed by re-reading the pane, so
  // rejecting an odd-but-silent response would fail sends that took effect.
  await new HerdrAgentCli(runnerFor('')).sendKeys('w3:p2', ['esc']);
});

test('wait: returns the settled agent', async () => {
  const calls: string[][] = [];
  const cli = new HerdrAgentCli(async (args) => {
    calls.push(args);
    return {
      stdout: JSON.stringify({
        id: 'cli:agent:wait',
        result: {
          type: 'agent_info',
          agent: {
            agent: 'claude', agent_session: { kind: 'id', value: 's1' }, agent_status: 'idle',
            cwd: '/tmp', pane_id: 'w3:p2', state_change_seq: 136,
          },
        },
      }),
      stderr: '',
    };
  });

  const settled = await cli.wait('w3:p2', ['idle', 'done'], 1000);
  assert.equal(settled?.status, 'idle');
  assert.equal(settled?.stateChangeSeq, 136);
  assert.deepEqual(calls[0], ['agent', 'wait', 'w3:p2', '--until', 'idle', '--until', 'done', '--timeout', '1000']);
});

test('wait: a timeout is null, not a settled agent', async () => {
  // herdr reports its own timeout as an error object. A caller that could not
  // tell "settled" from "gave up" would report an unanswered dialog as answered.
  const body = JSON.stringify({ error: { code: 'timeout', message: 'timed out waiting for agent status' } });
  assert.equal(await new HerdrAgentCli(runnerFor(body)).wait('w3:p2', ['idle'], 10), null);
});

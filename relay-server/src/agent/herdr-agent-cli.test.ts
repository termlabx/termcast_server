import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HerdrAgentCli, herdrCommand, type HerdrRunner } from './herdr-agent-cli.js';

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
  });
  assert.equal(agents[1].status, 'working');
  assert.equal(agents[1].paneId, 'w3:p1');
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { OpencodeClient } from './opencode-client.js';

/** Spins a stub opencode server; returns its base URL and a stop function. */
async function stub(routes: Record<string, unknown>): Promise<{ url: string; stop: () => Promise<void>; server: Server }> {
  const server = createServer((req, res) => {
    const body = routes[`${req.method} ${req.url}`];
    if (body === undefined) { res.statusCode = 404; res.end('{}'); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test('listSessions: maps opencode session JSON onto AgentSessionSummary', async () => {
  const s = await stub({
    'GET /api/session': {
      data: [{
        id: 'ses_abc',
        title: 'Fix the parser',
        projectID: 'p1',
        agent: 'build',
        model: { id: 'big-pickle', providerID: 'opencode' },
        time: { created: 1784740005997, updated: 1784740171153 },
        location: { directory: '/Users/me/Projects/repo' },
      }],
    },
  });

  const sessions = await new OpencodeClient(s.url).listSessions();
  await s.stop();

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'ses_abc');
  assert.equal(sessions[0].agent, 'opencode');
  assert.equal(sessions[0].title, 'Fix the parser');
  assert.equal(sessions[0].projectPath, '/Users/me/Projects/repo');
  assert.equal(sessions[0].model, 'big-pickle');
  assert.equal(sessions[0].lastActiveAt, new Date(1784740171153).toISOString());
  assert.equal(sessions[0].messageCount, null);
  assert.equal(sessions[0].isLive, false);
});

test('listSessions: a session missing optional fields still lists', async () => {
  const s = await stub({ 'GET /api/session': { data: [{ id: 'ses_bare' }] } });

  const sessions = await new OpencodeClient(s.url).listSessions();
  await s.stop();

  assert.equal(sessions[0].id, 'ses_bare');
  assert.equal(sessions[0].title, 'Untitled session');
  assert.equal(sessions[0].projectPath, '');
  assert.equal(sessions[0].model, null);
});

test('listSessions: an unreachable server yields [] rather than throwing', async () => {
  // opencode simply may not be installed. That is not an error condition.
  const sessions = await new OpencodeClient('http://127.0.0.1:1').listSessions();

  assert.deepEqual(sessions, []);
});

test('listMessages: text parts become text blocks with ordinal seq', async () => {
  const s = await stub({
    'GET /api/session/ses_abc/message': {
      data: [
        { info: { id: 'msg_1', role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
        { info: { id: 'msg_2', role: 'assistant' }, parts: [{ type: 'text', text: 'hi there' }] },
      ],
    },
  });

  const messages = await new OpencodeClient(s.url).listMessages('ses_abc');
  await s.stop();

  assert.equal(messages.length, 2);
  assert.equal(messages[0].seq, 0);
  assert.equal(messages[1].seq, 1);
  assert.equal(messages[0].role, 'user');
  assert.deepEqual(messages[0].blocks, [{ kind: 'text', text: 'hello' }]);
});

test('listMessages: a tool part becomes a toolUse block', async () => {
  const s = await stub({
    'GET /api/session/ses_abc/message': {
      data: [{
        info: { id: 'msg_1', role: 'assistant' },
        parts: [{ type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'completed', input: { command: 'npm test' }, output: 'ok' } }],
      }],
    },
  });

  const [message] = await new OpencodeClient(s.url).listMessages('ses_abc');
  await s.stop();

  assert.equal(message.blocks[0].kind, 'toolUse');
  assert.equal((message.blocks[0] as { summary: string }).summary, 'npm test');
  assert.equal(message.blocks[1].kind, 'toolResult');
  assert.equal((message.blocks[1] as { preview: string }).preview, 'ok');
});

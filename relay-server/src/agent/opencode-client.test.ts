import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OpencodeClient, isTurnRunning, pendingFlags } from './opencode-client.js';

/** Creates a scratch SQLite store matching opencode's message/part schema. */
function fixtureDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'oc-client-'));
  const path = join(dir, 'opencode.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `);
  const put = (table: 'message' | 'part', row: Record<string, string | number>) => {
    const cols = Object.keys(row).join(', ');
    const params = Object.keys(row).map((k) => `$${k}`).join(', ');
    db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${params})`).run(row);
  };
  put('message', { id: 'msg_1', session_id: 'ses_abc', time_created: 1000, time_updated: 1000, data: JSON.stringify({ role: 'user', time: { created: 1000 }, agent: 'build' }) });
  put('part', { id: 'prt_1', message_id: 'msg_1', session_id: 'ses_abc', time_created: 1000, time_updated: 1000, data: JSON.stringify({ type: 'text', text: 'hello' }) });
  put('message', { id: 'msg_2', session_id: 'ses_abc', time_created: 2000, time_updated: 2000, data: JSON.stringify({ role: 'assistant', time: { created: 2000 }, agent: 'build' }) });
  put('part', { id: 'prt_2', message_id: 'msg_2', session_id: 'ses_abc', time_created: 2000, time_updated: 2000, data: JSON.stringify({ type: 'text', text: 'hi there' }) });
  put('part', { id: 'prt_3', message_id: 'msg_2', session_id: 'ses_abc', time_created: 2001, time_updated: 2001, data: JSON.stringify({ type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'completed', input: { command: 'npm test' }, output: 'ok' } }) });
  db.close();
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Spins a stub opencode server; returns its base URL and a stop function. */
async function stub(
  routes: Record<string, unknown>,
  seen?: { path: string; body: unknown; directory?: string }[],
): Promise<{ url: string; stop: () => Promise<void>; server: Server }> {
  const server = createServer((req, res) => {
    // Routed on the path alone: query params are hints older opencode ignores,
    // so a route must answer whether or not the client sent them.
    const path = (req.url ?? '').split('?')[0];
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      seen?.push({
        path,
        body: raw ? JSON.parse(raw) : null,
        directory: req.headers['x-opencode-directory'] as string | undefined,
      });
      const body = routes[`${req.method} ${path}`];
      if (body === undefined) {
        // Mirrors the real failure: an unmatched route falls through to the
        // opencode web UI, which answers 200 with HTML rather than a 404.
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html');
        res.end('<!doctype html><html><body>OpenCode</body></html>');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    });
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

test('listSessions: filters out observer/subagent and empty placeholder sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-filt-'));
  const dbPath = join(dir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT);
           CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT,
             time_created INTEGER, time_updated INTEGER, data TEXT);`);
  db.prepare('INSERT INTO session (id, parent_id) VALUES (?, ?)').run('ses_user', null);
  db.prepare('INSERT INTO session (id, parent_id) VALUES (?, ?)').run('ses_sub', 'ses_parent');
  db.prepare('INSERT INTO session (id, parent_id) VALUES (?, ?)').run('ses_empty', null);
  db.prepare('INSERT INTO message (id, session_id) VALUES (?, ?)').run('m1', 'ses_user');
  db.prepare('INSERT INTO message (id, session_id) VALUES (?, ?)').run('m2', 'ses_sub');
  db.close();

  const s = await stub({
    'GET /api/session': {
      data: [
        { id: 'ses_user', title: 'Fix the parser' },
        { id: 'ses_sub', title: 'Find role recognition (@explore)' },
        { id: 'ses_empty', title: 'New session - 2026-08-03T00:00:00.000Z' },
      ],
    },
  });
  try {
    const sessions = await new OpencodeClient(s.url, dbPath).listSessions();
    assert.deepEqual(sessions.map((x) => x.id), ['ses_user']);
  } finally {
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listSessions: no dbPath keeps the unfiltered HTTP listing', async () => {
  const s = await stub({
    'GET /api/session': { data: [{ id: 'ses_a' }, { id: 'ses_b' }] },
  });
  const sessions = await new OpencodeClient(s.url).listSessions();
  await s.stop();
  assert.deepEqual(sessions.map((x) => x.id), ['ses_a', 'ses_b']);
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

test('listMessages: reads the transcript from the SQLite store when a dbPath is given', async () => {
  const db = fixtureDb();
  try {
    // The base URL is deliberately unreachable: messages must come from the store.
    const messages = await new OpencodeClient('http://127.0.0.1:1', db.path).listMessages('ses_abc');

    assert.equal(messages.length, 2);
    assert.equal(messages[0].seq, 0);
    assert.equal(messages[0].id, 'msg_1');
    assert.equal(messages[0].role, 'user');
    assert.deepEqual(messages[0].blocks, [{ kind: 'text', text: 'hello' }]);
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[1].blocks[0].kind, 'text');
    assert.equal(messages[1].blocks[1].kind, 'toolUse');
    assert.equal((messages[1].blocks[1] as { summary: string }).summary, 'npm test');
    assert.equal(messages[1].blocks[2].kind, 'toolResult');
  } finally {
    db.cleanup();
  }
});

test('listMessages: a store with no rows for the session yields [] (not an error)', async () => {
  const db = fixtureDb();
  try {
    const messages = await new OpencodeClient('http://127.0.0.1:1', db.path).listMessages('ses_other');
    assert.deepEqual(messages, []);
  } finally {
    db.cleanup();
  }
});

test('sendMessage: a failed send does not fabricate the bubble in the store', async () => {
  // This used to write the user's message straight into the legacy `message`
  // and `part` tables so it "showed up immediately". Two things were wrong with
  // that: opencode stopped reading those tables after the session_message
  // migration, and writing them made a send that opencode never received look
  // like it had worked. The bubble appeared, no reply ever came, and the phone
  // showed "Working…" indefinitely. A send that fails must fail loudly.
  const db = fixtureDb();
  try {
    const client = new OpencodeClient('http://127.0.0.1:1', db.path);

    await assert.rejects(() => client.sendMessage('ses_abc', 'please continue'), /did not accept/);

    const messages = await client.listMessages('ses_abc');
    assert.equal(messages.length, 2);
    assert.ok(!messages.some((m) => m.blocks.some((b) => b.kind === 'text' && b.text === 'please continue')));
  } finally {
    db.cleanup();
  }
});

test('listMessages: carries opencode\'s creation time onto each message', async () => {
  // The phone stamps every bubble, and opencode records the time in the store
  // rather than in the HTTP payload — so it has to come off the row.
  const db = fixtureDb();
  try {
    const messages = await new OpencodeClient('http://127.0.0.1:1', db.path).listMessages('ses_abc');

    assert.equal(messages[0].timestamp, new Date(1000).toISOString());
    assert.equal(messages[1].timestamp, new Date(2000).toISOString());
  } finally {
    db.cleanup();
  }
});

// --- v2 API -----------------------------------------------------------------
//
// opencode moved messages to a `session_message` store fronted by the `/api`
// (v2) routes. The legacy `message`/`part` SQLite tables still hold everything
// written before the upgrade, and the unversioned `/session/...` routes still
// read those — so the two APIs serve two different halves of the history and a
// client that reads only one never sees new turns.

test('sendMessage: posts the v2 prompt route', async () => {
  const seen: { path: string; body: unknown; directory?: string }[] = [];
  const s = await stub({ 'POST /api/session/ses_abc/prompt': { data: { admittedSeq: 1 } } }, seen);
  try {
    await new OpencodeClient(s.url).sendMessage('ses_abc', 'say hi');

    assert.deepEqual(seen.map((r) => r.path), ['/api/session/ses_abc/prompt']);
    assert.deepEqual(seen[0].body, { prompt: { text: 'say hi' } });
  } finally {
    await s.stop();
  }
});

test('sendMessage: falls back to the legacy route on an opencode without /prompt', async () => {
  const seen: { path: string; body: unknown; directory?: string }[] = [];
  const s = await stub({ 'POST /session/ses_abc/message': [] }, seen);
  try {
    await new OpencodeClient(s.url).sendMessage('ses_abc', 'say hi');

    assert.deepEqual(seen.map((r) => r.path), ['/api/session/ses_abc/prompt', '/session/ses_abc/message']);
    assert.deepEqual(seen[1].body, { parts: [{ type: 'text', text: 'say hi' }] });
  } finally {
    await s.stop();
  }
});

test('sendMessage: throws when no route accepts the prompt', async () => {
  // The failure this guards against shipped: the old route returned the web
  // UI's index.html with HTTP 200, res.json() threw, the throw was swallowed,
  // and the phone sat on "Working…" forever for a turn opencode never saw.
  const s = await stub({});
  try {
    await assert.rejects(
      () => new OpencodeClient(s.url).sendMessage('ses_abc', 'say hi'),
      /did not accept/,
    );
  } finally {
    await s.stop();
  }
});

test('listMessages: parses the v2 message shape', async () => {
  const s = await stub({
    'GET /api/session/ses_abc/message': {
      // Newest first, as the route returns them.
      data: [
        {
          id: 'msg_2', type: 'assistant', time: { created: 2000, completed: 2500 }, finish: 'stop',
          content: [
            { type: 'reasoning', text: 'thinking about it' },
            { type: 'text', text: 'pong' },
            { type: 'tool', id: 'call_1', name: 'bash', state: { status: 'completed', input: { command: 'echo hi' }, content: [{ type: 'text', text: 'hi\n' }] } },
          ],
        },
        { id: 'msg_1', type: 'user', time: { created: 1000 }, text: 'ping' },
      ],
    },
  });
  try {
    const messages = await new OpencodeClient(s.url).listMessages('ses_abc');

    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.deepEqual(messages[0].blocks, [{ kind: 'text', text: 'ping' }]);
    assert.equal(messages[0].timestamp, new Date(1000).toISOString());

    assert.equal(messages[1].role, 'assistant');
    assert.deepEqual(messages[1].blocks, [
      { kind: 'thinking', text: 'thinking about it' },
      { kind: 'text', text: 'pong' },
      { kind: 'toolUse', toolUseId: 'call_1', name: 'bash', summary: 'echo hi', input: '{"command":"echo hi"}', truncated: false },
      { kind: 'toolResult', toolUseId: 'call_1', ok: true, preview: 'hi\n', truncated: false },
    ]);
  } finally {
    await s.stop();
  }
});

test('listMessages: legacy history comes before the live v2 turns', async () => {
  // A session that predates the upgrade keeps its transcript in the old tables
  // while every new turn lands in the v2 store. Reading either alone loses half
  // the conversation.
  const db = fixtureDb();
  const s = await stub({
    'GET /api/session/ses_abc/message': {
      data: [{ id: 'msg_new', type: 'user', time: { created: 9000 }, text: 'sent from the phone' }],
    },
  });
  try {
    const messages = await new OpencodeClient(s.url, db.path).listMessages('ses_abc');

    assert.deepEqual(messages.map((m) => m.id), ['msg_1', 'msg_2', 'msg_new']);
    assert.deepEqual(messages.map((m) => m.seq), [0, 1, 2]);
  } finally {
    await s.stop();
    db.cleanup();
  }
});

test('isTurnRunning: a turn is running until the last assistant message settles', () => {
  const user = { role: 'user' as const, finish: null, completed: null };
  const toolCalls = { role: 'assistant' as const, finish: 'tool-calls', completed: 2000 };
  const done = { role: 'assistant' as const, finish: 'stop', completed: 3000 };
  const streaming = { role: 'assistant' as const, finish: null, completed: null };

  // Nothing has answered yet.
  assert.equal(isTurnRunning([user]), true);
  // Mid-stream: the assistant message exists but has not completed.
  assert.equal(isTurnRunning([user, streaming]), true);
  // A tool-calls finish is always followed by another assistant message.
  assert.equal(isTurnRunning([user, toolCalls]), true);
  // Settled.
  assert.equal(isTurnRunning([user, toolCalls, done]), false);
  assert.equal(isTurnRunning([]), false);
});

test('pendingFlags: a user message is pending until a completed turn answers it', () => {
  const user = { role: 'user' as const, finish: null, completed: null };
  const toolCalls = { role: 'assistant' as const, finish: 'tool-calls', completed: 2000 };
  const done = { role: 'assistant' as const, finish: 'stop', completed: 3000 };
  const streaming = { role: 'assistant' as const, finish: null, completed: null };

  // The single unanswered prompt is pending.
  assert.deepEqual(pendingFlags([user]), [true]);
  // Still being answered — the assistant message has not settled.
  assert.deepEqual(pendingFlags([user, streaming]), [true, false]);
  // A tool-calls turn is not the end of its own answer.
  assert.deepEqual(pendingFlags([user, toolCalls]), [true, false]);
  // Settled, oldest to newest: the queue is empty.
  assert.deepEqual(pendingFlags([user, toolCalls, done]), [false, false, false]);
});

test('pendingFlags: a message sent while a turn runs queues behind it', () => {
  const user = { role: 'user' as const, finish: null, completed: null };
  const done = { role: 'assistant' as const, finish: 'stop', completed: 3000 };
  const streaming = { role: 'assistant' as const, finish: null, completed: null };

  // The newest user turn is the one still waiting on its answer; the turn
  // before it was answered and must not wear the queue badge.
  const states = [user, done, user];
  const flags = pendingFlags(states);
  assert.deepEqual(flags, [false, false, true]);
});

test('requests carry the session directory so one serve can drive every project', async () => {
  // `opencode serve` resolves the project from its own cwd unless told
  // otherwise, and it only *runs* turns for sessions in that project. termcastd
  // spawns the serve from its install directory, so without this header a
  // prompt for one of the user's real sessions was accepted (HTTP 200, an
  // admitted message id) and then never executed — the phone's "Working…" sat
  // there forever waiting on a turn opencode was never going to start.
  const seen: { path: string; body: unknown; directory?: string }[] = [];
  const s = await stub({
    'GET /api/session': { data: [{ id: 'ses_abc', title: 'T', location: { directory: '/Users/me/repo' } }] },
    'POST /api/session/ses_abc/prompt': { data: { admittedSeq: 1 } },
  }, seen);
  try {
    const client = new OpencodeClient(s.url);
    await client.listSessions();
    await client.sendMessage('ses_abc', 'go');

    const prompt = seen.find((r) => r.path === '/api/session/ses_abc/prompt');
    assert.equal(prompt?.directory, '/Users/me/repo');
  } finally {
    await s.stop();
  }
});

test('the session directory is recovered from the store when no listing preceded the send', async () => {
  // attach/history can run before any listSessions on this client instance.
  const dir = mkdtempSync(join(tmpdir(), 'oc-dir-'));
  const dbPath = join(dir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT);');
  db.prepare('INSERT INTO session (id, parent_id, directory) VALUES (?, ?, ?)').run('ses_abc', null, '/Users/me/other');
  db.close();

  const seen: { path: string; body: unknown; directory?: string }[] = [];
  const s = await stub({ 'POST /api/session/ses_abc/prompt': { data: { admittedSeq: 1 } } }, seen);
  try {
    await new OpencodeClient(s.url, dbPath).sendMessage('ses_abc', 'go');

    assert.equal(seen[0].directory, '/Users/me/other');
  } finally {
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listSessions: a session whose messages are only in the v2 store still lists', async () => {
  // The "has messages" test that drops empty placeholders originally looked at
  // the legacy `message` table alone. After the session_message migration that
  // table stops growing, so every session created from then on looked empty and
  // was filtered out — the phone's opencode list would slowly freeze in the
  // past, showing only sessions that predated the upgrade.
  const dir = mkdtempSync(join(tmpdir(), 'oc-v2list-'));
  const dbPath = join(dir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT);
           CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT);
           CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT);`);
  db.prepare('INSERT INTO session (id, parent_id) VALUES (?, ?)').run('ses_old', null);
  db.prepare('INSERT INTO session (id, parent_id) VALUES (?, ?)').run('ses_new', null);
  db.prepare('INSERT INTO session (id, parent_id) VALUES (?, ?)').run('ses_empty', null);
  db.prepare('INSERT INTO message (id, session_id) VALUES (?, ?)').run('m1', 'ses_old');
  db.prepare('INSERT INTO session_message (id, session_id) VALUES (?, ?)').run('sm1', 'ses_new');
  db.close();

  const s = await stub({
    'GET /api/session': {
      data: [
        { id: 'ses_old', title: 'Before the upgrade' },
        { id: 'ses_new', title: 'After the upgrade' },
        { id: 'ses_empty', title: 'New session - 2026-08-03T00:00:00.000Z' },
      ],
    },
  });
  try {
    const sessions = await new OpencodeClient(s.url, dbPath).listSessions();
    assert.deepEqual(sessions.map((x) => x.id), ['ses_old', 'ses_new']);
  } finally {
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

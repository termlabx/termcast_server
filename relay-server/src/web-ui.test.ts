import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { WebUI } from './web-ui.js';
import type { Multiplexer } from './multiplexer.js';
import { generatePairingInfo } from './pairing.js';
import { AgentLogRing } from './agent-log.js';

function samplePairing() {
  return generatePairingInfo('wss://r', Buffer.alloc(32, 1), 'dev1');
}

function freePort(): Promise<number> {
  return new Promise(r => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      r((s.address() as net.AddressInfo).port);
      s.close();
    });
  });
}

test('GET /forwards serves the port-forwards page', async () => {
  const ui = new WebUI();
  const port = await freePort();
  await ui.start(port);
  after(() => ui.stop());

  const resp = await fetch(`http://127.0.0.1:${ui.port}/forwards`);
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get('content-type') ?? '', /text\/html/);
  const body = await resp.text();
  assert.ok(body.includes('Port Forwards'));
  assert.ok(body.includes('/api/mesh/forwards'));
});

test('POST /api/mesh/forwards without a handler returns 503', async () => {
  const ui = new WebUI();
  const port = await freePort();
  await ui.start(port);
  after(() => ui.stop());

  const resp = await fetch(`http://127.0.0.1:${ui.port}/api/mesh/forwards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peer: 'x', action: 'add', remotePort: 3000 }),
  });
  assert.equal(resp.status, 503);
});

test('POST /api/mesh/forwards routes the body through the handler', async () => {
  const ui = new WebUI();
  const port = await freePort();
  await ui.start(port);
  after(() => ui.stop());

  let received: unknown = null;
  ui.setMeshForwardHandler((change) => { received = change; return { ok: true, note: 'hi' }; });

  const resp = await fetch(`http://127.0.0.1:${ui.port}/api/mesh/forwards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peer: 'Mac', action: 'add', remotePort: 3000 }),
  });
  assert.equal(resp.status, 200);
  assert.deepEqual(await resp.json(), { ok: true, note: 'hi' });
  assert.deepEqual(received, { peer: 'Mac', action: 'add', remotePort: 3000 });
});

test('POST /api/leave invokes the leave handler', async () => {
  const ui = new WebUI();
  const port = await freePort();
  await ui.start(port);
  after(() => ui.stop());

  let called = 0;
  ui.setLeaveHandler(() => { called++; return { ok: true }; });

  const resp = await fetch(`http://127.0.0.1:${ui.port}/api/leave`, { method: 'POST' });
  assert.equal(resp.status, 200);
  assert.deepEqual(await resp.json(), { ok: true });
  assert.equal(called, 1);
});

test('POST /api/leave without a handler returns 503', async () => {
  const ui = new WebUI();
  const port = await freePort();
  await ui.start(port);
  after(() => ui.stop());

  const resp = await fetch(`http://127.0.0.1:${ui.port}/api/leave`, { method: 'POST' });
  assert.equal(resp.status, 503);
});

test('GET /api/pairing?new=1 mints a token, registers a grant, returns qr + qr_text', async () => {
  const ui = new WebUI();
  const port = await freePort();
  await ui.start(port);
  after(() => ui.stop());

  let registered = 0;
  ui.setRegenerateCallback(async () => samplePairing());
  ui.setGrantRegistrar(async () => { registered++; });

  const resp = await fetch(`http://127.0.0.1:${ui.port}/api/pairing?new=1`);
  assert.equal(resp.status, 200);
  const body = await resp.json() as { qr: string; qr_text: string; expires_at: number };
  assert.ok(body.qr.startsWith('data:image/png;base64,'));
  assert.ok(body.qr_text.length > 0);
  assert.equal(registered, 1);
});

test('GET /api/pairing (no new) displays the current QR without minting or registering', async () => {
  const ui = new WebUI();
  const port = await freePort();
  await ui.start(port);
  after(() => ui.stop());

  let regenerated = 0;
  let registered = 0;
  ui.setPairing(samplePairing());
  ui.setRegenerateCallback(async () => { regenerated++; return samplePairing(); });
  ui.setGrantRegistrar(async () => { registered++; });

  const resp = await fetch(`http://127.0.0.1:${ui.port}/api/pairing`);
  assert.equal(resp.status, 200);
  const body = await resp.json() as { qr: string };
  assert.ok(body.qr.startsWith('data:image/png;base64,'));
  assert.equal(regenerated, 0, 'plain poll must not mint a new token');
  assert.equal(registered, 0, 'plain poll must not register a grant');
});

async function uiWithMultiplexer(active: Multiplexer = 'tmux', installed = { tmux: true, herdr: false }) {
  const ui = new WebUI();
  await ui.start(await freePort());
  const installCalls: string[] = [];
  ui.setMultiplexerHandlers({
    get: () => ({ active, installed }),
    install: async (n) => { installCalls.push(n); },
  });
  return { ui, installCalls };
}

test('GET /api/multiplexer: reports the active one and what is installed', async () => {
  const { ui } = await uiWithMultiplexer();
  after(() => ui.stop());

  const resp = await fetch(`http://127.0.0.1:${ui.port}/api/multiplexer`);
  assert.equal(resp.status, 200);
  assert.deepEqual(await resp.json(), { active: 'tmux', installed: { tmux: true, herdr: false } });
});

// The active multiplexer is detected, not set, so the route that used to
// change it is gone: a stored value is a second source of truth that drifts.
test('POST /api/multiplexer: refuses explicitly rather than 200-ing the dashboard HTML', async () => {
  const { ui } = await uiWithMultiplexer();
  after(() => ui.stop());

  const resp = await fetch(`http://127.0.0.1:${ui.port}/api/multiplexer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ multiplexer: 'herdr' }),
  });
  assert.equal(resp.status, 405);
  assert.match((await resp.json() as { error: string }).error, /cannot be set/);
});

test('POST /api/multiplexer/install: routes the requested binary to the installer', async () => {
  const { ui, installCalls } = await uiWithMultiplexer();
  after(() => ui.stop());

  const resp = await fetch(`http://127.0.0.1:${ui.port}/api/multiplexer/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'herdr' }),
  });
  assert.equal(resp.status, 200);
  assert.deepEqual(installCalls, ['herdr']);
});

test('GET /api/multiplexer without handlers returns 503', async () => {
  const ui = new WebUI();
  await ui.start(await freePort());
  after(() => ui.stop());

  const resp = await fetch(`http://127.0.0.1:${ui.port}/api/multiplexer`);
  assert.equal(resp.status, 503);
});

test('GET /multiplexer serves the multiplexer settings page', async () => {
  const { ui } = await uiWithMultiplexer();
  after(() => ui.stop());

  const resp = await fetch(`http://127.0.0.1:${ui.port}/multiplexer`);
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get('content-type') ?? '', /text\/html/);
  const body = await resp.text();
  assert.ok(body.includes('Terminal Multiplexer'));
  assert.ok(body.includes('/api/multiplexer'));
});

test('GET /api/pairing/consumed resolves true when notifyPairingConsumed fires', async () => {
  const ui = new WebUI();
  const port = await freePort();
  await ui.start(port);
  after(() => ui.stop());

  const pending = fetch(`http://127.0.0.1:${ui.port}/api/pairing/consumed`).then(r => r.json());
  setTimeout(() => ui.notifyPairingConsumed(), 50);
  assert.deepEqual(await pending, { consumed: true });
});

async function startWebUi(deps: { isAttached: (sessionId: string) => boolean }) {
  const ui = new WebUI();
  const { PermissionBroker } = await import('./agent/permission-broker.js');
  const broker = new PermissionBroker();
  ui.setPermissionHandler({ broker, isAttached: deps.isAttached });
  await ui.start(await freePort());
  return {
    url: `http://127.0.0.1:${ui.port}`,
    broker,
    stop: () => ui.stop(),
  };
}

test('POST /api/agent/permission: no attached phone answers immediately with no decision', async () => {
  const { url, stop } = await startWebUi({ isAttached: () => false });

  const res = await fetch(`${url}/api/agent/permission`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' }),
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {});
  await stop();
});

test('POST /api/agent/permission: an attached phone decision is returned', async () => {
  const { url, broker, stop } = await startWebUi({ isAttached: () => true });
  broker.onRequest((req) => broker.resolve(req.requestId, 'allow'));

  const res = await fetch(`${url}/api/agent/permission`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' }),
  });

  assert.deepEqual(await res.json(), { behavior: 'allow' });
  await stop();
});

test('POST /api/agent/permission: a malformed body yields no decision rather than an error', async () => {
  const { url, stop } = await startWebUi({ isAttached: () => true });

  const res = await fetch(`${url}/api/agent/permission`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json',
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {});
  await stop();
});

test('GET /agent-log serves the agent log page', async () => {
  const ui = new WebUI();
  await ui.start(await freePort());
  after(() => ui.stop());

  const resp = await fetch(`http://127.0.0.1:${ui.port}/agent-log`);
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get('content-type') ?? '', /text\/html/);
  const body = await resp.text();
  assert.ok(body.includes('Agent Log'));
  assert.ok(body.includes('/api/agent/log'));
});

test('GET /api/agent/log serves the ring the daemon filled', async () => {
  const ui = new WebUI();
  await ui.start(await freePort());
  after(() => ui.stop());

  const ring = new AgentLogRing(10);
  ring.record('->', { conn: 1, agent: 'claude', session: 's1', type: 'send', text: 'hi' });
  ui.setAgentLogRing(ring);

  const resp = await fetch(`http://127.0.0.1:${ui.port}/api/agent/log`);
  assert.equal(resp.status, 200);
  const body = await resp.json() as { rows: { type: string; detail: string }[]; lastSeq: number };
  assert.deepEqual(body.rows.map(r => r.type), ['send']);
  assert.equal(body.rows[0].detail, '"hi"');
  assert.equal(body.lastSeq, 1);
});

test('GET /api/agent/log?since= returns only rows the poller has not seen', async () => {
  const ui = new WebUI();
  await ui.start(await freePort());
  after(() => ui.stop());

  const ring = new AgentLogRing(10);
  ring.record('->', { conn: 1, type: 'list' });
  ring.record('->', { conn: 1, type: 'detach' });
  ui.setAgentLogRing(ring);

  const resp = await fetch(`http://127.0.0.1:${ui.port}/api/agent/log?since=1`);
  const body = await resp.json() as { rows: { type: string }[] };
  assert.deepEqual(body.rows.map(r => r.type), ['detach']);
});

test('GET /api/agent/log with a junk since returns the whole ring rather than nothing', async () => {
  // A missing or malformed cursor must not silently produce an empty page.
  const ui = new WebUI();
  await ui.start(await freePort());
  after(() => ui.stop());

  const ring = new AgentLogRing(10);
  ring.record('->', { conn: 1, type: 'list' });
  ui.setAgentLogRing(ring);

  const resp = await fetch(`http://127.0.0.1:${ui.port}/api/agent/log?since=abc`);
  const body = await resp.json() as { rows: unknown[] };
  assert.equal(body.rows.length, 1);
});

test('GET /api/agent/log before anything is wired reports an empty log', async () => {
  const ui = new WebUI();
  await ui.start(await freePort());
  after(() => ui.stop());

  const resp = await fetch(`http://127.0.0.1:${ui.port}/api/agent/log`);
  assert.equal(resp.status, 200);
  assert.deepEqual(await resp.json(), { rows: [], lastSeq: 0 });
});

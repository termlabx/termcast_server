import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { WebUI } from './web-ui.js';
import type { Multiplexer } from './multiplexer.js';
import { generatePairingInfo } from './pairing.js';

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
  const setCalls: string[] = [];
  const installCalls: string[] = [];
  ui.setMultiplexerHandlers({
    get: () => ({ active, installed }),
    set: (m) => { setCalls.push(m); },
    install: async (n) => { installCalls.push(n); },
  });
  return { ui, setCalls, installCalls };
}

test('GET /api/multiplexer: reports the active one and what is installed', async () => {
  const { ui } = await uiWithMultiplexer();
  after(() => ui.stop());

  const resp = await fetch(`http://127.0.0.1:${ui.port}/api/multiplexer`);
  assert.equal(resp.status, 200);
  assert.deepEqual(await resp.json(), { active: 'tmux', installed: { tmux: true, herdr: false } });
});

test('POST /api/multiplexer: accepts a known name and applies it', async () => {
  const { ui, setCalls } = await uiWithMultiplexer();
  after(() => ui.stop());

  const resp = await fetch(`http://127.0.0.1:${ui.port}/api/multiplexer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ multiplexer: 'herdr' }),
  });
  assert.equal(resp.status, 200);
  assert.deepEqual(setCalls, ['herdr']);
});

// Strict membership, not parseMultiplexer's lenient default: a typo must 400,
// never silently switch the machine to tmux.
test('POST /api/multiplexer: rejects an unknown multiplexer name', async () => {
  const { ui, setCalls } = await uiWithMultiplexer();
  after(() => ui.stop());

  const resp = await fetch(`http://127.0.0.1:${ui.port}/api/multiplexer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ multiplexer: 'zellij' }),
  });
  assert.equal(resp.status, 400);
  assert.deepEqual(setCalls, []);
});

test('POST /api/multiplexer: blocks cross-origin requests like the other mutating routes', async () => {
  const { ui, setCalls } = await uiWithMultiplexer();
  after(() => ui.stop());

  const resp = await fetch(`http://127.0.0.1:${ui.port}/api/multiplexer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: JSON.stringify({ multiplexer: 'herdr' }),
  });
  assert.equal(resp.status, 403);
  assert.deepEqual(setCalls, []);
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

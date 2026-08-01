import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatStatus, formatDuration, type StatusSnapshot } from './status.js';

function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    version: '0.32.0',
    serverPid: 1234,
    uptimeSeconds: 3725,
    relay: { url: 'wss://relay.example.dev', connected: true },
    ttyd: { pid: 5678, port: 7681, running: true, uptimeSeconds: 60 },
    clients: [],
    cloudflare: { httpRequests: 2, wsConnects: 1, wsMessagesSent: 40, total: 43 },
    mesh: [],
    ...overrides,
  };
}

test('formatDuration renders human-friendly spans', () => {
  assert.equal(formatDuration(5), '5s');
  assert.equal(formatDuration(90), '1m 30s');
  assert.equal(formatDuration(3725), '1h 2m');
  assert.equal(formatDuration(90000), '1d 1h');
});

test('formatStatus (no color) reports running server and relay usage', () => {
  const out = formatStatus(snapshot(), { color: false });
  assert.match(out, /Termcast running/);
  assert.match(out, /v0\.32\.0/);
  assert.match(out, /up 1h 2m/);
  assert.match(out, /pid 1234/);
  assert.match(out, /connected/);
  assert.match(out, /total\s+43/);
  assert.match(out, /ws messages\s+40/);
});

test('formatStatus lists connected clients with pairing state', () => {
  const out = formatStatus(snapshot({
    clients: [
      { id: 1, ip: '1.2.3.4', location: 'Tokyo, JP', device: 'iPhone', paired: true, connectedAt: Date.now() - 5000 },
      { id: 2, paired: false, connectedAt: Date.now() },
    ],
  }), { color: false });
  assert.match(out, /Clients \(2 connected\)/);
  assert.match(out, /\[1\] \[paired\] 1\.2\.3\.4 · Tokyo, JP · iPhone/);
  assert.match(out, /\[2\] \[pairing\] unknown client/);
});

test('formatStatus shows "none" when no clients are connected', () => {
  const out = formatStatus(snapshot(), { color: false });
  assert.match(out, /Clients \(0 connected\)/);
  assert.match(out, /none/);
});

test('formatStatus reports ttyd not running', () => {
  const out = formatStatus(snapshot({
    ttyd: { pid: null, port: 7681, running: false, uptimeSeconds: null },
  }), { color: false });
  assert.match(out, /termcastd[\s\S]*not running/);
});

test('formatStatus lists mesh peers when present', () => {
  const out = formatStatus(snapshot({
    mesh: [{ name: 'laptop', port: 7682 }],
  }), { color: false });
  assert.match(out, /Mesh peers/);
  assert.match(out, /laptop → localhost:7682/);
});

test('formatStatus renders mesh forwards with state', () => {
  const snap: StatusSnapshot = {
    version: '1.0.0',
    serverPid: 1,
    uptimeSeconds: 5,
    relay: { url: 'wss://x', connected: true },
    ttyd: { pid: 2, port: 7681, running: true, uptimeSeconds: 5 },
    clients: [],
    cloudflare: { httpRequests: 0, wsConnects: 0, wsMessagesSent: 0, total: 0 },
    mesh: [{
      name: 'Mac',
      port: 9701,
      forwards: [
        { remotePort: 3000, localPort: 3000, state: 'active' },
        { remotePort: 8080, localPort: 18080, state: 'error', message: 'address in use' },
      ],
    }],
  };
  const out = formatStatus(snap, { color: false });
  assert.ok(out.includes('Mac → localhost:9701'));
  assert.ok(out.includes('localhost:3000 → :3000'));
  assert.ok(out.includes('active'));
  assert.ok(out.includes('localhost:18080 → :8080'));
  assert.ok(out.includes('error: address in use'));
});

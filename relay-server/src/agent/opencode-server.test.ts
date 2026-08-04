import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOpencodeBaseUrl, resolveOpencodeBin, OpencodeServer } from './opencode-server.js';

async function healthyServer(): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{}'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, stop: () => new Promise<void>((r) => server.close(() => r())) };
}

test('resolveOpencodeBaseUrl: an explicit override wins without probing', async () => {
  const url = await resolveOpencodeBaseUrl({ override: 'http://127.0.0.1:9999', candidates: [] });

  assert.equal(url, 'http://127.0.0.1:9999');
});

test('resolveOpencodeBaseUrl: reuses an already-running server', async () => {
  const running = await healthyServer();

  const url = await resolveOpencodeBaseUrl({ candidates: [running.url] });
  await running.stop();

  assert.equal(url, running.url);
});

test('resolveOpencodeBaseUrl: yields null when nothing is listening', async () => {
  const url = await resolveOpencodeBaseUrl({ candidates: ['http://127.0.0.1:1'] });

  assert.equal(url, null);
});

test('resolveOpencodeBin: prefers an explicit candidate over a PATH search', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-bin-'));
  const wanted = join(dir, 'wanted');
  writeFileSync(wanted, '#!/bin/sh\n');
  chmodSync(wanted, 0o755);
  const alsoOnPath = join(dir, 'path-bin');
  mkdirSync(alsoOnPath, { recursive: true });
  writeFileSync(join(alsoOnPath, 'opencode'), '#!/bin/sh\n');
  chmodSync(join(alsoOnPath, 'opencode'), 0o755);

  const found = resolveOpencodeBin({ candidates: [wanted], pathEnv: alsoOnPath });

  assert.equal(found, wanted);
});

test('resolveOpencodeBin: falls back to a PATH search when no candidate matches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-path-'));
  writeFileSync(join(dir, 'opencode'), '#!/bin/sh\n');
  chmodSync(join(dir, 'opencode'), 0o755);

  const found = resolveOpencodeBin({ candidates: ['/nonexistent/opencode'], pathEnv: dir });

  assert.equal(found, join(dir, 'opencode'));
});

test('resolveOpencodeBin: yields null when nothing exists', () => {
  const found = resolveOpencodeBin({ candidates: ['/nonexistent/opencode'], pathEnv: '/nonexistent' });

  assert.equal(found, null);
});

test('OpencodeServer.ensureRunning: reuses a healthy running server and its cached URL', async () => {
  const running = await healthyServer();
  const server = new OpencodeServer();

  const first = await server.ensureRunning({ candidates: [running.url] });
  const second = await server.ensureRunning({ candidates: [] });

  await running.stop();

  assert.equal(first, running.url);
  assert.equal(second, running.url);
});

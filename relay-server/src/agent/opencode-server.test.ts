import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolveOpencodeBaseUrl } from './opencode-server.js';

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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { PortForwardHandler, PF_OPEN, PF_DATA, PF_CLOSE, PF_OPEN_ACK } from './port-forward.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseFrame(buf: Buffer) {
  return {
    subCmd: buf[0],
    flowId: buf.readUInt32BE(1),
    payload: buf.subarray(5),
  };
}

function openPayload(remotePort: number, localPort: number): Buffer {
  return Buffer.from(JSON.stringify({ remotePort, localPort }));
}

function firstDataPayload(remotePort: number, data: Buffer): Buffer {
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(remotePort, 0);
  return Buffer.concat([prefix, data]);
}

class RelaySink {
  messages: Buffer[] = [];
  push = (data: Buffer) => { this.messages.push(data); };

  async waitFor(n: number, ms = 3000): Promise<void> {
    const t0 = Date.now();
    while (this.messages.length < n) {
      if (Date.now() - t0 > ms) throw new Error(`Timeout: wanted ${n} msgs, got ${this.messages.length}`);
      await new Promise(r => setTimeout(r, 20));
    }
  }

  ofType(subCmd: number) {
    return this.messages.map(parseFrame).filter(m => m.subCmd === subCmd);
  }

  clear() { this.messages = []; }
}

async function echoServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const conns: net.Socket[] = [];
  return new Promise(resolve => {
    const srv = net.createServer(s => {
      s.on('error', () => {}); // ignore resets from probes or forced teardown
      conns.push(s);
      s.on('data', d => s.write(d));
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      resolve({
        port,
        close: () => {
          for (const c of conns) c.destroy();
          return new Promise<void>(r => srv.close(() => r()));
        },
      });
    });
  });
}

/** Start a TCP server that waits for data, sends a fixed response, and closes */
async function responseServer(resp: string): Promise<{ port: number; close: () => Promise<void> }> {
  const conns: net.Socket[] = [];
  return new Promise(resolve => {
    const srv = net.createServer(s => {
      s.on('error', () => {}); // ignore client resets
      conns.push(s);
      s.once('data', () => { s.write(resp); s.end(); });
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      resolve({
        port,
        close: () => {
          for (const c of conns) c.destroy();
          return new Promise<void>(r => srv.close(() => r()));
        },
      });
    });
  });
}

async function unusedPort(): Promise<number> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function setup() {
  const sink = new RelaySink();
  const handler = new PortForwardHandler(sink.push);
  return { sink, handler };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('PF_OPEN: ACK ok when port reachable', async () => {
  const { sink, handler } = setup();
  const srv = await echoServer();
  try {
    handler.handleMessage(PF_OPEN, 0, openPayload(srv.port, 9999));
    await sink.waitFor(1);
    const ack = JSON.parse(sink.ofType(PF_OPEN_ACK)[0].payload.toString());
    assert.equal(ack.status, 'ok');
    assert.equal(ack.remotePort, srv.port);
  } finally {
    handler.destroyAll();
    await srv.close();
  }
});

test('PF_OPEN: ACK error when port unreachable', async () => {
  const { sink, handler } = setup();
  const port = await unusedPort();
  try {
    handler.handleMessage(PF_OPEN, 0, openPayload(port, 9999));
    await sink.waitFor(1);
    const ack = JSON.parse(sink.ofType(PF_OPEN_ACK)[0].payload.toString());
    assert.equal(ack.status, 'error');
    assert.ok(ack.message);
  } finally {
    handler.destroyAll();
  }
});

test('PF_OPEN: exactly one ACK (no duplicates from races)', async () => {
  const { sink, handler } = setup();
  const port = await unusedPort();
  try {
    handler.handleMessage(PF_OPEN, 0, openPayload(port, 9999));
    await sleep(500);
    assert.equal(sink.ofType(PF_OPEN_ACK).length, 1);
  } finally {
    handler.destroyAll();
  }
});

test('PF_DATA: echo flow round-trip', async () => {
  const { sink, handler } = setup();
  const srv = await echoServer();
  try {
    handler.handleMessage(PF_OPEN, 0, openPayload(srv.port, 9999));
    await sink.waitFor(1);
    sink.clear();

    handler.handleMessage(PF_DATA, 1, firstDataPayload(srv.port, Buffer.from('hello')));
    await sink.waitFor(1, 2000);

    const data = sink.ofType(PF_DATA);
    assert.equal(data.length, 1);
    assert.equal(data[0].flowId, 1);
    assert.deepEqual(data[0].payload, Buffer.from('hello'));
  } finally {
    handler.destroyAll();
    await srv.close();
  }
});

test('PF_DATA: subsequent data has no remotePort prefix', async () => {
  const { sink, handler } = setup();
  const srv = await echoServer();
  try {
    handler.handleMessage(PF_OPEN, 0, openPayload(srv.port, 9999));
    await sink.waitFor(1);
    sink.clear();

    handler.handleMessage(PF_DATA, 42, firstDataPayload(srv.port, Buffer.from('first')));
    await sink.waitFor(1, 2000);
    sink.clear();

    handler.handleMessage(PF_DATA, 42, Buffer.from('second'));
    await sink.waitFor(1, 2000);

    const data = sink.ofType(PF_DATA);
    assert.equal(data[0].flowId, 42);
    assert.deepEqual(data[0].payload, Buffer.from('second'));
  } finally {
    handler.destroyAll();
    await srv.close();
  }
});

test('PF_CLOSE from client tears down flow', async () => {
  const { sink, handler } = setup();
  const srv = await echoServer();
  try {
    handler.handleMessage(PF_OPEN, 0, openPayload(srv.port, 9999));
    await sink.waitFor(1);
    sink.clear();

    handler.handleMessage(PF_DATA, 10, firstDataPayload(srv.port, Buffer.from('hi')));
    await sink.waitFor(1, 2000);
    sink.clear();

    handler.handleMessage(PF_CLOSE, 10, Buffer.alloc(0));
    await sleep(100);

    // Flow is gone — subsequent data for the same flowId is treated as zombie
    handler.handleMessage(PF_DATA, 10, Buffer.from('zombie'));
    await sleep(200);

    // Should get a PF_CLOSE back for the zombie (unregistered port or short data)
    const closes = sink.ofType(PF_CLOSE);
    assert.ok(closes.length >= 1, 'should reject zombie data');
  } finally {
    handler.destroyAll();
    await srv.close();
  }
});

test('PF_CLOSE sent when server closes connection', async () => {
  const { sink, handler } = setup();
  const srv = await responseServer('bye');
  try {
    handler.handleMessage(PF_OPEN, 0, openPayload(srv.port, 9999));
    await sink.waitFor(1);
    sink.clear();

    handler.handleMessage(PF_DATA, 20, firstDataPayload(srv.port, Buffer.from('req')));
    await sleep(500);

    const closes = sink.ofType(PF_CLOSE);
    assert.ok(closes.length >= 1, 'should get PF_CLOSE when server hangs up');
    assert.equal(closes[0].flowId, 20);
  } finally {
    handler.destroyAll();
    await srv.close();
  }
});

test('no duplicate PF_CLOSE on socket error + close', async () => {
  const { sink, handler } = setup();
  // Use a server that tracks connections so we can force-destroy them
  const conns: net.Socket[] = [];
  const srv = await new Promise<{ port: number; close: () => Promise<void> }>(resolve => {
    const s = net.createServer(c => { c.on('error', () => {}); conns.push(c); c.on('data', d => c.write(d)); });
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      resolve({ port, close: () => new Promise<void>(r => s.close(() => r())) });
    });
  });
  try {
    handler.handleMessage(PF_OPEN, 0, openPayload(srv.port, 9999));
    await sink.waitFor(1);
    sink.clear();

    handler.handleMessage(PF_DATA, 30, firstDataPayload(srv.port, Buffer.from('x')));
    await sink.waitFor(1, 2000);
    sink.clear();

    // Force-destroy all server-side sockets to trigger errors on the handler's sockets
    for (const c of conns) c.destroy();
    await srv.close();
    await sleep(500);

    const closes = sink.ofType(PF_CLOSE).filter(m => m.flowId === 30);
    assert.equal(closes.length, 1, 'exactly one PF_CLOSE, not two');
  } finally {
    handler.destroyAll();
  }
});

test('PF_CLOSE for unreachable flow port', async () => {
  const { sink, handler } = setup();
  const port = await unusedPort();
  try {
    // Register port (ACK will be error, but port is still registered)
    handler.handleMessage(PF_OPEN, 0, openPayload(port, 9999));
    await sink.waitFor(1);
    sink.clear();

    handler.handleMessage(PF_DATA, 50, firstDataPayload(port, Buffer.from('data')));
    await sleep(500);

    const closes = sink.ofType(PF_CLOSE);
    assert.ok(closes.length >= 1, 'should PF_CLOSE on ECONNREFUSED');
    assert.equal(closes[0].flowId, 50);
  } finally {
    handler.destroyAll();
  }
});

test('multiple concurrent flows to same port', async () => {
  const { sink, handler } = setup();
  const srv = await echoServer();
  try {
    handler.handleMessage(PF_OPEN, 0, openPayload(srv.port, 9999));
    await sink.waitFor(1);
    sink.clear();

    for (const id of [100, 101, 102]) {
      handler.handleMessage(PF_DATA, id, firstDataPayload(srv.port, Buffer.from(`f${id}`)));
    }
    await sink.waitFor(3, 3000);

    const data = sink.ofType(PF_DATA);
    for (const id of [100, 101, 102]) {
      const msg = data.find(m => m.flowId === id);
      assert.ok(msg, `flow ${id} should have response`);
      assert.ok(msg!.payload.toString().includes(`f${id}`), `flow ${id} echoed correct data`);
    }
  } finally {
    handler.destroyAll();
    await srv.close();
  }
});

test('multiple flows to different ports', async () => {
  const { sink, handler } = setup();
  const srv1 = await echoServer();
  const srv2 = await echoServer();
  try {
    handler.handleMessage(PF_OPEN, 0, openPayload(srv1.port, 9001));
    handler.handleMessage(PF_OPEN, 0, openPayload(srv2.port, 9002));
    await sink.waitFor(2);
    sink.clear();

    handler.handleMessage(PF_DATA, 200, firstDataPayload(srv1.port, Buffer.from('p1')));
    handler.handleMessage(PF_DATA, 201, firstDataPayload(srv2.port, Buffer.from('p2')));
    await sink.waitFor(2, 3000);

    const data = sink.ofType(PF_DATA);
    assert.deepEqual(data.find(m => m.flowId === 200)!.payload, Buffer.from('p1'));
    assert.deepEqual(data.find(m => m.flowId === 201)!.payload, Buffer.from('p2'));
  } finally {
    handler.destroyAll();
    await srv1.close();
    await srv2.close();
  }
});

test('unregistered port rejected with PF_CLOSE', async () => {
  const { sink, handler } = setup();
  try {
    handler.handleMessage(PF_DATA, 300, firstDataPayload(12345, Buffer.from('x')));
    await sleep(200);

    const closes = sink.ofType(PF_CLOSE);
    assert.ok(closes.length >= 1);
    assert.equal(closes[0].flowId, 300);
  } finally {
    handler.destroyAll();
  }
});

test('destroyAll cleans up all state', async () => {
  const { sink, handler } = setup();
  const srv = await echoServer();
  try {
    handler.handleMessage(PF_OPEN, 0, openPayload(srv.port, 9999));
    await sink.waitFor(1);
    sink.clear();

    handler.handleMessage(PF_DATA, 400, firstDataPayload(srv.port, Buffer.from('a')));
    await sink.waitFor(1, 2000);
    sink.clear();

    handler.destroyAll();
    await sleep(200);

    // registeredPorts cleared — new data should be rejected
    handler.handleMessage(PF_DATA, 400, firstDataPayload(srv.port, Buffer.from('z')));
    await sleep(200);

    const closes = sink.ofType(PF_CLOSE);
    assert.ok(closes.some(m => m.flowId === 400), 'should reject after destroyAll');
  } finally {
    handler.destroyAll();
    await srv.close();
  }
});

test('short PF_DATA payload rejected', async () => {
  const { sink, handler } = setup();
  try {
    handler.handleMessage(PF_DATA, 500, Buffer.from([0x42]));
    await sleep(200);

    const closes = sink.ofType(PF_CLOSE);
    assert.ok(closes.length >= 1);
    assert.equal(closes[0].flowId, 500);
  } finally {
    handler.destroyAll();
  }
});

test('PF_CLOSE for nonexistent flow is no-op', () => {
  const { handler } = setup();
  // Should not throw
  handler.handleMessage(PF_CLOSE, 999, Buffer.alloc(0));
  handler.destroyAll();
});

test('HTTP request/response end-to-end', async () => {
  const { sink, handler } = setup();
  const httpResp = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK';
  const srv = await new Promise<{ port: number; close: () => Promise<void> }>(resolve => {
    const s = net.createServer(conn => {
      let buf = '';
      conn.on('data', d => {
        buf += d.toString();
        if (buf.includes('\r\n\r\n')) { conn.write(httpResp); conn.end(); }
      });
    });
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      resolve({ port, close: () => new Promise<void>(r => s.close(() => r())) });
    });
  });

  try {
    handler.handleMessage(PF_OPEN, 0, openPayload(srv.port, 8888));
    await sink.waitFor(1);
    sink.clear();

    const req = Buffer.from('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');
    handler.handleMessage(PF_DATA, 600, firstDataPayload(srv.port, req));
    await sleep(500);

    const data = sink.ofType(PF_DATA).filter(m => m.flowId === 600);
    assert.ok(data.length >= 1, 'got HTTP response');
    const body = Buffer.concat(data.map(m => m.payload)).toString();
    assert.ok(body.includes('200 OK'));
    assert.ok(body.includes('OK'));

    const closes = sink.ofType(PF_CLOSE).filter(m => m.flowId === 600);
    assert.ok(closes.length >= 1, 'PF_CLOSE after HTTP response');
  } finally {
    handler.destroyAll();
    await srv.close();
  }
});

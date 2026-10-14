import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createBifrostServer } from '../server/server.js';
import { idFromSecret, randomB64 } from '../shared/auth.js';

async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-test-'));
  const app = createBifrostServer({ port: 0, host: '127.0.0.1', dataDir });
  const port = await app.listen();
  return { app, port, dataDir, url: `ws://127.0.0.1:${port}/ws` };
}

/** WebSocket with a message queue so tests can await messages in order. */
function client(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on('message', (data, isBinary) => {
    const item = isBinary ? { binary: data } : JSON.parse(data.toString());
    const w = waiters.shift();
    if (w) w(item);
    else queue.push(item);
  });
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  return {
    ws,
    closed,
    open: () => new Promise((r, j) => (ws.once('open', r), ws.once('error', j))),
    next: () =>
      new Promise((resolve, reject) => {
        if (queue.length) return resolve(queue.shift());
        const t = setTimeout(() => reject(new Error('timeout waiting for message')), 3000);
        waiters.push((m) => (clearTimeout(t), resolve(m)));
      }),
    send: (m) => ws.send(JSON.stringify(m)),
    close: () => ws.close(),
  };
}

async function newHost(url) {
  const secret = randomB64(32);
  const id = await idFromSecret(secret);
  const host = client(url);
  await host.open();
  host.send({ t: 'host', id, secret });
  assert.deepEqual(await host.next(), { srv: 'registered', id });
  return { host, id, secret };
}

async function newViewer(url, id) {
  const viewer = client(url);
  await viewer.open();
  viewer.send({ t: 'viewer' });
  assert.equal((await viewer.next()).srv, 'ready');
  viewer.send({ t: 'connect', id });
  return viewer;
}

test('pairs a viewer with a host and relays both ways, then tears down', async () => {
  const { app, url } = await start();
  try {
    const { host, id } = await newHost(url);
    const viewer = await newViewer(url, id);

    const peer = await host.next();
    assert.equal(peer.srv, 'peer');
    assert.ok(peer.ip);
    assert.equal((await viewer.next()).srv, 'paired');

    host.send({ t: 'challenge', nonce: 'abc' });
    assert.deepEqual(await viewer.next(), { t: 'challenge', nonce: 'abc' });

    viewer.send({ t: 'auth', proof: null, mode: 'view' });
    assert.deepEqual(await host.next(), { t: 'auth', proof: null, mode: 'view' });

    host.ws.send(Buffer.from([1, 0, 4, 0, 3, 0xff, 0xd8]), { binary: true });
    const frame = await viewer.next();
    assert.deepEqual([...frame.binary], [1, 0, 4, 0, 3, 0xff, 0xd8]);

    viewer.send({ t: 'leave' });
    assert.deepEqual(await host.next(), { srv: 'peer-left' });
    assert.deepEqual(await viewer.next(), { srv: 'ended', reason: 'viewer-left' });

    // The host can be reached again afterwards.
    const again = await newViewer(url, id);
    assert.equal((await host.next()).srv, 'peer');
    assert.equal((await again.next()).srv, 'paired');
    again.close();
    host.close();
  } finally {
    await app.close();
  }
});

test('encrypted viewer packets reach the host as binary, oversized ones are dropped', async () => {
  const { app, url } = await start();
  try {
    const { host, id } = await newHost(url);
    const viewer = await newViewer(url, id);
    assert.equal((await host.next()).srv, 'peer');
    await viewer.next();

    viewer.ws.send(Buffer.alloc(200000, 7), { binary: true }); // over the 64 KB cap: dropped
    viewer.ws.send(Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 9, 9]), { binary: true });
    const got = await host.next();
    assert.deepEqual([...got.binary], [2, 0, 0, 0, 0, 0, 0, 0, 0, 9, 9]);
    host.close();
    viewer.close();
  } finally {
    await app.close();
  }
});

test('an unpaired viewer cannot push binary to a host', async () => {
  const { app, url } = await start();
  try {
    const { host, id } = await newHost(url);
    const viewer = client(url);
    await viewer.open();
    viewer.send({ t: 'viewer' });
    await viewer.next();
    viewer.ws.send(Buffer.from([2, 1, 2, 3]), { binary: true });
    // A later legitimate pairing must be the next thing the host sees.
    viewer.send({ t: 'connect', id });
    assert.equal((await host.next()).srv, 'peer');
    host.close();
    viewer.close();
  } finally {
    await app.close();
  }
});

test('offline and busy hosts are reported', async () => {
  const { app, url } = await start();
  try {
    const none = await newViewer(url, '000000001');
    assert.deepEqual(await none.next(), { srv: 'error', code: 'offline' });

    const { host, id } = await newHost(url);
    const first = await newViewer(url, id);
    assert.equal((await host.next()).srv, 'peer');
    assert.equal((await first.next()).srv, 'paired');

    const second = await newViewer(url, id);
    assert.deepEqual(await second.next(), { srv: 'error', code: 'busy' });
    for (const c of [first, second, host]) c.close();
  } finally {
    await app.close();
  }
});

test('an ID cannot be taken over with a different secret', async () => {
  const { app, url } = await start();
  try {
    const { host, id } = await newHost(url);
    const thief = client(url);
    await thief.open();
    thief.send({ t: 'host', id, secret: randomB64(32) });
    assert.deepEqual(await thief.next(), { srv: 'error', code: 'id_taken' });
    await thief.closed;
    host.close();
  } finally {
    await app.close();
  }
});

test('IDs survive a server restart', async () => {
  const first = await start();
  const { host, id, secret } = await newHost(first.url);
  host.close();
  await first.app.close();

  const app = createBifrostServer({ port: 0, host: '127.0.0.1', dataDir: first.dataDir });
  const port = await app.listen();
  try {
    const thief = client(`ws://127.0.0.1:${port}/ws`);
    await thief.open();
    thief.send({ t: 'host', id, secret: randomB64(32) });
    assert.equal((await thief.next()).code, 'id_taken');

    const back = client(`ws://127.0.0.1:${port}/ws`);
    await back.open();
    back.send({ t: 'host', id, secret });
    assert.equal((await back.next()).srv, 'registered');
    back.close();
  } finally {
    await app.close();
  }
});

test('a viewer cannot forge server messages toward the host', async () => {
  const { app, url } = await start();
  try {
    const { host, id } = await newHost(url);
    const viewer = await newViewer(url, id);
    assert.equal((await host.next()).srv, 'peer');
    await viewer.next();

    viewer.send({ srv: 'peer', t: 'x', ip: '10.0.0.1' }); // forged: must be dropped
    viewer.send({ t: 'auth', proof: null });
    const got = await host.next();
    assert.deepEqual(got, { t: 'auth', proof: null });
    host.close();
    viewer.close();
  } finally {
    await app.close();
  }
});

test('invalid hello is rejected', async () => {
  const { app, url } = await start();
  try {
    const bad = client(url);
    await bad.open();
    bad.send({ t: 'host', id: 'abc', secret: 'nope' });
    assert.equal((await bad.next()).code, 'bad_hello');
    await bad.closed;
  } finally {
    await app.close();
  }
});

test('serves only the viewer files', async () => {
  const { app, port } = await start();
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /Bifrost/);
    assert.match(ok.headers.get('content-security-policy'), /default-src 'self'/);
    for (const p of ['/package.json', '/server/server.js', '/../package.json', '/data/ids.json']) {
      assert.equal((await fetch(`http://127.0.0.1:${port}${p}`)).status, 404, p);
    }
  } finally {
    await app.close();
  }
});

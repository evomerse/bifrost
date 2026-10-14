// The viewer's TransferClient against the real host FileService, wired back to back
// (the encrypted channel in between is covered by session.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileService } from '../agent/files.js';
import { TransferClient, TransferError } from '../viewer/transfer.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pair({ policy = 'allow', answer = true, hostBuffered = () => 0, viewerBuffered = () => 0 } = {}) {
  const inbox = tmp('bf-t-in-');
  const outbox = tmp('bf-t-out-');
  const toViewer = [];
  const client = new TransferClient({
    sendJson: (m) => queueMicrotask(() => svc.handle(m)),
    sendChunk: (id, last, bytes) => queueMicrotask(() => svc.onChunk(id, last, Buffer.from(bytes))),
    bufferedAmount: viewerBuffered,
  });
  const svc = new FileService({
    roots: [
      { name: 'Inbox', dir: inbox, read: true, write: true },
      { name: 'Outbox', dir: outbox, read: true, write: false },
    ],
    policy,
    ask: async () => answer,
    send: (m) => {
      toViewer.push(m);
      queueMicrotask(() => client.handle(m));
    },
    sendChunk: (id, last, data) => queueMicrotask(() => client.handleChunk({ id, last, data: Buffer.from(data) })),
    bufferedAmount: hostBuffered,
  });
  return { client, svc, inbox, outbox, toViewer };
}

function memorySink() {
  const parts = [];
  const sink = {
    opened: null,
    closed: false,
    aborted: false,
    open: (name, size) => (sink.opened = { name, size }),
    write: async (b) => {
      await sleep(1); // a slow disk: chunks must still be written in order
      parts.push(Buffer.from(b));
    },
    close: () => (sink.closed = true),
    abort: () => (sink.aborted = true),
    get data() {
      return Buffer.concat(parts);
    },
  };
  return sink;
}

test('upload a multi-chunk file and see it on the host', async () => {
  const env = pair();
  const data = Buffer.alloc(100_000);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  const progress = [];
  const { promise } = env.client.upload(new File([data], 'données.bin'), '/Inbox', (done, total) => progress.push([done, total]));
  const done = await promise;
  assert.deepEqual([done.name, done.size, done.path], ['données.bin', 100_000, '/Inbox/données.bin']);
  assert.deepEqual(fs.readFileSync(path.join(env.inbox, 'données.bin')), data);
  assert.deepEqual(progress.at(-1), [100_000, 100_000]);
  assert.ok(progress.length >= 4, 'progress reported per chunk');
});

test('upload of an empty file', async () => {
  const env = pair();
  const done = await env.client.upload(new File([], 'vide.txt'), '/Inbox').promise;
  assert.equal(done.size, 0);
  assert.equal(fs.statSync(path.join(env.inbox, 'vide.txt')).size, 0);
});

test('upload waits for the host user to accept, and stops when refused', async () => {
  const env = pair({ policy: 'ask', answer: false });
  await assert.rejects(env.client.upload(new File(['abc'], 'a.txt'), '/Inbox').promise, (e) => e instanceof TransferError && e.reason === 'refused');
  assert.deepEqual(fs.readdirSync(env.inbox), []);
});

test('upload backpressure: nothing is sent while the socket is congested', async () => {
  let level = 4 * 1024 * 1024;
  const env = pair({ viewerBuffered: () => level });
  const { promise } = env.client.upload(new File([Buffer.alloc(70_000, 1)], 'slow.bin'), '/Inbox');
  await sleep(60);
  assert.deepEqual(fs.readdirSync(env.inbox).filter((n) => !n.endsWith('.bifrost-part')), []);
  const part = fs.readdirSync(env.inbox).find((n) => n.endsWith('.bifrost-part'));
  assert.equal(fs.statSync(path.join(env.inbox, part)).size, 0, 'no bytes written yet');
  level = 0;
  await promise;
  assert.equal(fs.statSync(path.join(env.inbox, 'slow.bin')).size, 70_000);
});

test('upload errors surface as TransferError with a readable message', async () => {
  const env = pair();
  await assert.rejects(env.client.upload(new File(['x'], 'con'), '/Inbox').promise, (e) => e.reason === 'bad-name' && /Nom de fichier/.test(e.message));
  await assert.rejects(env.client.upload(new File(['x'], 'ok.txt'), '/Outbox').promise, (e) => e.reason === 'not-allowed');
  await assert.rejects(env.client.upload(new File(['x'], 'ok.txt'), '/Inbox/../Outbox').promise, (e) => e.reason === 'bad-path');
});

test('download streams into the sink in order and verifies the size', async () => {
  const env = pair();
  const data = Buffer.alloc(150_000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7) % 256;
  fs.writeFileSync(path.join(env.outbox, 'rapport.bin'), data);
  const sink = memorySink();
  const progress = [];
  const done = await env.client.download('/Outbox/rapport.bin', sink, (r, t) => progress.push([r, t])).promise;
  assert.deepEqual(done, { name: 'rapport.bin', size: 150_000 });
  assert.deepEqual(sink.opened, { name: 'rapport.bin', size: 150_000 });
  assert.equal(sink.closed, true);
  assert.deepEqual(sink.data, data);
  assert.deepEqual(progress.at(-1), [150_000, 150_000]);
});

test('download of an empty file and of a missing file', async () => {
  const env = pair();
  fs.writeFileSync(path.join(env.outbox, 'empty.txt'), '');
  const sink = memorySink();
  const done = await env.client.download('/Outbox/empty.txt', sink).promise;
  assert.equal(done.size, 0);
  assert.equal(sink.closed, true);

  const sink2 = memorySink();
  await assert.rejects(env.client.download('/Outbox/missing.txt', sink2).promise, (e) => e.reason === 'not-found');
  assert.equal(sink2.opened, null);
});

test('download refused by the host user', async () => {
  const env = pair({ policy: 'ask', answer: false });
  fs.writeFileSync(path.join(env.outbox, 'f.txt'), 'secret');
  const sink = memorySink();
  await assert.rejects(env.client.download('/Outbox/f.txt', sink).promise, (e) => e.reason === 'refused');
  assert.equal(sink.data.length, 0);
});

test('list: roots, then a folder', async () => {
  const env = pair();
  fs.writeFileSync(path.join(env.outbox, 'a.txt'), 'a');
  fs.mkdirSync(path.join(env.outbox, 'dossier'));
  const roots = await env.client.list('/');
  assert.deepEqual(roots.entries.map((e) => e.name), ['Inbox', 'Outbox']);
  const out = await env.client.list('/Outbox');
  assert.deepEqual(out.entries.map((e) => [e.name, e.dir]), [['dossier', true], ['a.txt', false]]);
  await assert.rejects(env.client.list('/Nope'), (e) => e.reason === 'not-found');
});

test('a sink failure aborts the download and reports an I/O error', async () => {
  const env = pair();
  fs.writeFileSync(path.join(env.outbox, 'big.bin'), Buffer.alloc(100_000, 2));
  let aborted = false;
  const sink = { open() {}, write: async () => { throw new Error('disk full'); }, close() {}, abort: () => (aborted = true) };
  await assert.rejects(env.client.download('/Outbox/big.bin', sink).promise, (e) => e.reason === 'io');
  assert.equal(aborted, true);
});

test('cancel stops a transfer and tells the host', async () => {
  const env = pair({ hostBuffered: () => 10 * 1024 * 1024 }); // the host would wait forever
  fs.writeFileSync(path.join(env.outbox, 'f.bin'), Buffer.alloc(80_000, 4));
  const sink = memorySink();
  const { id, promise } = env.client.download('/Outbox/f.bin', sink);
  await sleep(20);
  env.client.cancel(id);
  await assert.rejects(promise, (e) => e.reason === 'cancelled');
  assert.equal(sink.aborted, true);
  assert.equal(env.client.transfers.size, 0);
});

test('abortAll rejects everything pending when the connection drops', async () => {
  const env = pair({ policy: 'ask' });
  env.svc.ask = () => new Promise(() => {}); // the dialog is never answered
  const a = env.client.upload(new File(['x'], 'a.txt'), '/Inbox').promise;
  const b = env.client.list('/never-answered-because-we-abort');
  env.client.abortAll();
  await assert.rejects(a, (e) => e.reason === 'cancelled');
  await assert.rejects(b, (e) => e.reason === 'cancelled');
});

test('replies for unknown transfers are ignored', () => {
  const env = pair();
  assert.equal(env.client.handle({ t: 'fs-done', id: 999 }), true);
  assert.equal(env.client.handle({ t: 'clip', text: 'x' }), false);
  env.client.handleChunk({ id: 999, last: true, data: Buffer.from('x') });
});

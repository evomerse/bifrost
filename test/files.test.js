import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHUNK_SIZE, FileService, safeName, uniqueName } from '../agent/files.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A FileService wired to in-memory sinks, over two temp share roots. */
function setup({ policy = 'allow', answer = true, maxFileBytes, buffered = () => 0 } = {}) {
  const inbox = tmp('bf-inbox-');
  const outbox = tmp('bf-outbox-');
  const sent = [];
  const chunks = [];
  const asked = [];
  const svc = new FileService({
    roots: [
      { name: 'Inbox', dir: inbox, read: true, write: true },
      { name: 'Outbox', dir: outbox, read: true, write: false },
    ],
    policy,
    ask: async (q) => (asked.push(q), answer),
    send: (m) => sent.push(m),
    sendChunk: (id, last, data) => chunks.push({ id, last, data: Buffer.from(data) }),
    bufferedAmount: buffered,
    maxFileBytes,
  });
  const reply = (t) => sent.filter((m) => m.t === t);
  return { svc, inbox, outbox, sent, chunks, asked, reply };
}

async function upload(env, { id = 1, name, data, dir }) {
  await env.svc.handle({ t: 'fs-put', id, name, size: data.length, dir });
  const ready = env.sent.find((m) => m.id === id && (m.t === 'fs-put-r' || m.t === 'fs-error'));
  if (!ready || ready.t === 'fs-error') return ready;
  for (let off = 0; off < data.length || off === 0; off += CHUNK_SIZE) {
    const part = data.subarray(off, off + CHUNK_SIZE);
    env.svc.onChunk(id, off + CHUNK_SIZE >= data.length, part);
    if (data.length === 0) break;
  }
  return env.sent.find((m) => m.id === id && (m.t === 'fs-done' || m.t === 'fs-error'));
}

test('file names are validated, never paths', () => {
  assert.equal(safeName('report.pdf'), 'report.pdf');
  assert.equal(safeName('Résumé final (2).docx'), 'Résumé final (2).docx');
  for (const bad of ['..', '.', '', 'a/b', 'a\\b', '..\\x', 'C:evil', 'a:stream', 'con', 'NUL.txt', 'lpt1', 'x.', 'x ', 'a|b', 'a<b', 'q?', 'ctl\u0001', 'x'.repeat(201), 42, null]) {
    assert.equal(safeName(bad), null, JSON.stringify(bad));
  }
});

test('unique names get a counter', () => {
  const d = tmp('bf-uniq-');
  assert.equal(uniqueName(d, 'a.txt'), 'a.txt');
  fs.writeFileSync(path.join(d, 'a.txt'), '1');
  assert.equal(uniqueName(d, 'a.txt'), 'a (1).txt');
  fs.writeFileSync(path.join(d, 'a (1).txt'), '1');
  assert.equal(uniqueName(d, 'a.txt'), 'a (2).txt');
});

test('upload: chunks are assembled, the file appears only when complete', async () => {
  const env = setup();
  const data = Buffer.alloc(CHUNK_SIZE * 2 + 123, 7);
  const done = await upload(env, { name: 'photo.bin', data });
  assert.equal(done.t, 'fs-done');
  assert.equal(done.size, data.length);
  assert.equal(done.path, '/Inbox/photo.bin');
  assert.deepEqual(fs.readFileSync(path.join(env.inbox, 'photo.bin')), data);
  assert.equal(fs.readdirSync(env.inbox).some((f) => f.endsWith('.bifrost-part')), false);
});

test('upload: an existing name is never overwritten', async () => {
  const env = setup();
  fs.writeFileSync(path.join(env.inbox, 'a.txt'), 'original');
  const done = await upload(env, { name: 'a.txt', data: Buffer.from('new') });
  assert.equal(done.name, 'a (1).txt');
  assert.equal(fs.readFileSync(path.join(env.inbox, 'a.txt'), 'utf8'), 'original');
  assert.equal(fs.readFileSync(path.join(env.inbox, 'a (1).txt'), 'utf8'), 'new');
});

test('upload: empty files work', async () => {
  const env = setup();
  const done = await upload(env, { name: 'empty.txt', data: Buffer.alloc(0) });
  assert.equal(done.t, 'fs-done');
  assert.equal(fs.statSync(path.join(env.inbox, 'empty.txt')).size, 0);
});

test('upload: wrong total size leaves nothing behind', async () => {
  const env = setup();
  await env.svc.handle({ t: 'fs-put', id: 5, name: 'short.bin', size: 100 });
  env.svc.onChunk(5, true, Buffer.alloc(60)); // promised 100, sent 60
  assert.equal(env.reply('fs-error').at(-1).reason, 'size');
  assert.deepEqual(fs.readdirSync(env.inbox), []);

  await env.svc.handle({ t: 'fs-put', id: 6, name: 'long.bin', size: 10 });
  env.svc.onChunk(6, false, Buffer.alloc(20)); // more than promised
  assert.equal(env.reply('fs-error').at(-1).reason, 'size');
  assert.deepEqual(fs.readdirSync(env.inbox), []);
});

test('upload: path traversal and unsafe names are refused', async () => {
  const env = setup();
  for (const name of ['../evil.txt', '..\\evil.txt', 'a/b.txt', 'con', 'x.']) {
    await env.svc.handle({ t: 'fs-put', id: 9, name, size: 1 });
    assert.equal(env.sent.at(-1).t, 'fs-error', name);
    assert.equal(env.sent.at(-1).reason, 'bad-name', name);
  }
  for (const dir of ['/Inbox/../Outbox', '/Inbox/..', '/Nope', '/Inbox/C:', '../x']) {
    await env.svc.handle({ t: 'fs-put', id: 9, name: 'ok.txt', size: 1, dir });
    assert.equal(env.sent.at(-1).t, 'fs-error', dir);
  }
  assert.deepEqual(fs.readdirSync(env.inbox), []);
  assert.deepEqual(fs.readdirSync(env.outbox), []);
});

test('upload: read-only roots and oversized files are refused', async () => {
  const env = setup({ maxFileBytes: 1000 });
  await env.svc.handle({ t: 'fs-put', id: 1, name: 'x.txt', size: 1, dir: '/Outbox' });
  assert.equal(env.sent.at(-1).reason, 'not-allowed');
  await env.svc.handle({ t: 'fs-put', id: 2, name: 'big.bin', size: 5000 });
  assert.equal(env.sent.at(-1).reason, 'too-large');
  await env.svc.handle({ t: 'fs-put', id: 3, name: 'neg.bin', size: -1 });
  assert.equal(env.sent.at(-1).reason, 'bad-size');
  await env.svc.handle({ t: 'fs-put', id: 4, name: 'frac.bin', size: 1.5 });
  assert.equal(env.sent.at(-1).reason, 'bad-size');
});

test('download: streams the file in chunks with a last marker', async () => {
  const env = setup();
  const data = Buffer.alloc(CHUNK_SIZE * 3 + 5, 9);
  fs.writeFileSync(path.join(env.outbox, 'big.bin'), data);
  await env.svc.handle({ t: 'fs-get', id: 11, path: '/Outbox/big.bin' });
  const head = env.reply('fs-get-r')[0];
  assert.deepEqual([head.name, head.size], ['big.bin', data.length]);
  const got = Buffer.concat(env.chunks.map((c) => c.data));
  assert.deepEqual(got, data);
  assert.equal(env.chunks.at(-1).last, true);
  assert.equal(env.chunks.slice(0, -1).some((c) => c.last), false);
  assert.ok(env.chunks.every((c) => c.id === 11 && c.data.length <= CHUNK_SIZE));
});

test('download: a file whose size is a multiple of the chunk size still ends properly', async () => {
  const env = setup();
  fs.writeFileSync(path.join(env.outbox, 'exact.bin'), Buffer.alloc(CHUNK_SIZE * 2, 1));
  await env.svc.handle({ t: 'fs-get', id: 12, path: '/Outbox/exact.bin' });
  assert.equal(env.chunks.at(-1).last, true);
  assert.equal(env.chunks.reduce((n, c) => n + c.data.length, 0), CHUNK_SIZE * 2);
});

test('download: waits while the link is congested', async () => {
  let level = 5 * 1024 * 1024;
  const env = setup({ buffered: () => level });
  fs.writeFileSync(path.join(env.outbox, 'f.bin'), Buffer.alloc(CHUNK_SIZE * 2, 3));
  const pending = env.svc.handle({ t: 'fs-get', id: 13, path: '/Outbox/f.bin' });
  await sleep(60);
  assert.equal(env.chunks.length, 0, 'nothing sent while the backlog is high');
  level = 0;
  await pending;
  assert.equal(env.chunks.at(-1).last, true);
});

test('download: only inside the roots, files only', async () => {
  const env = setup();
  const secret = tmp('bf-secret-');
  fs.writeFileSync(path.join(secret, 'passwords.txt'), 'x');
  fs.mkdirSync(path.join(env.outbox, 'sub'));
  const cases = [
    ['/Outbox/../' + path.basename(secret) + '/passwords.txt', 'bad-path'],
    ['/Outbox/sub', 'not-a-file'],
    ['/Nope/x', 'not-found'],
    ['/Outbox/missing.txt', 'not-found'],
    ['C:/Windows/win.ini', 'not-found'],
    ['', 'bad-path'],
  ];
  for (const [p, reason] of cases) {
    await env.svc.handle({ t: 'fs-get', id: 20, path: p });
    assert.equal(env.sent.at(-1).t, 'fs-error', p);
    assert.equal(env.sent.at(-1).reason, reason, p);
  }
  assert.equal(env.chunks.length, 0);
});

test('a junction or symlink inside a root cannot reach outside it', async () => {
  const env = setup();
  const secret = tmp('bf-secret-');
  fs.writeFileSync(path.join(secret, 'passwords.txt'), 'top secret');
  const link = path.join(env.outbox, 'escape');
  try {
    fs.symlinkSync(secret, link, 'junction'); // needs no privilege on Windows
  } catch {
    return; // platform cannot create it: nothing to test
  }
  await env.svc.handle({ t: 'fs-get', id: 30, path: '/Outbox/escape/passwords.txt' });
  assert.equal(env.sent.at(-1).t, 'fs-error');
  assert.equal(env.sent.at(-1).reason, 'not-allowed');
  assert.equal(env.chunks.length, 0);

  await env.svc.handle({ t: 'fs-list', id: 31, path: '/Outbox/escape' });
  assert.equal(env.sent.at(-1).reason, 'not-allowed');

  // writing through a junction in a writable root is refused too
  const wlink = path.join(env.inbox, 'out');
  fs.symlinkSync(secret, wlink, 'junction');
  await env.svc.handle({ t: 'fs-put', id: 32, name: 'planted.txt', size: 1, dir: '/Inbox/out' });
  assert.equal(env.sent.at(-1).reason, 'not-allowed');
  assert.equal(fs.existsSync(path.join(secret, 'planted.txt')), false);
});

test('listing: roots, directories first, hidden internals', async () => {
  const env = setup();
  fs.writeFileSync(path.join(env.outbox, 'b.txt'), 'bb');
  fs.mkdirSync(path.join(env.outbox, 'docs'));
  fs.writeFileSync(path.join(env.outbox, 'a.txt'), 'a');

  await env.svc.handle({ t: 'fs-list', id: 1, path: '/' });
  const roots = env.reply('fs-list-r')[0];
  assert.deepEqual(roots.entries.map((e) => [e.name, e.dir, e.write]), [['Inbox', true, true], ['Outbox', true, false]]);
  assert.equal(JSON.stringify(roots).includes(env.outbox), false, 'real paths are never revealed');

  await env.svc.handle({ t: 'fs-list', id: 2, path: '/Outbox' });
  const list = env.reply('fs-list-r')[1];
  assert.deepEqual(list.entries.map((e) => e.name), ['docs', 'a.txt', 'b.txt']);
  assert.equal(list.entries[1].size, 1);
});

test('policy ask: the person is asked, once per transfer, and may refuse', async () => {
  const env = setup({ policy: 'ask', answer: false });
  const refused = await upload(env, { id: 1, name: 'x.txt', data: Buffer.from('hi') });
  assert.equal(refused.reason, 'refused');
  assert.equal(env.asked.length, 1);
  assert.match(env.asked[0].text, /x\.txt/);
  assert.deepEqual(fs.readdirSync(env.inbox), []);

  fs.writeFileSync(path.join(env.outbox, 'f.txt'), 'f');
  await env.svc.handle({ t: 'fs-get', id: 2, path: '/Outbox/f.txt' });
  assert.equal(env.sent.at(-1).reason, 'refused');
  assert.equal(env.chunks.length, 0);
  assert.equal(env.asked.length, 2);
});

test('policy ask: accepted transfers go through', async () => {
  const env = setup({ policy: 'ask', answer: true });
  const done = await upload(env, { name: 'ok.txt', data: Buffer.from('hello') });
  assert.equal(done.t, 'fs-done');
  assert.equal(env.asked.length, 1);
});

test('policy deny: nothing is listed, sent or received', async () => {
  const env = setup({ policy: 'deny' });
  fs.writeFileSync(path.join(env.outbox, 'f.txt'), 'f');
  for (const m of [{ t: 'fs-list', path: '/' }, { t: 'fs-get', path: '/Outbox/f.txt' }, { t: 'fs-put', name: 'a', size: 1 }]) {
    await env.svc.handle({ ...m, id: 1 });
    assert.deepEqual(env.sent.at(-1), { t: 'fs-error', id: 1, reason: 'disabled' });
  }
  assert.equal(env.asked.length, 0);
});

test('cancel and dispose remove partial uploads', async () => {
  const env = setup();
  await env.svc.handle({ t: 'fs-put', id: 1, name: 'p.bin', size: 100000 });
  env.svc.onChunk(1, false, Buffer.alloc(10));
  assert.equal(fs.readdirSync(env.inbox).length, 1, 'a .part file exists meanwhile');
  await env.svc.handle({ t: 'fs-cancel', id: 1 });
  assert.deepEqual(fs.readdirSync(env.inbox), []);

  await env.svc.handle({ t: 'fs-put', id: 2, name: 'q.bin', size: 100000 });
  env.svc.onChunk(2, false, Buffer.alloc(10));
  env.svc.dispose();
  assert.deepEqual(fs.readdirSync(env.inbox), []);
});

test('chunks for unknown or foreign transfers are ignored', async () => {
  const env = setup();
  env.svc.onChunk(99, true, Buffer.from('x'));
  fs.writeFileSync(path.join(env.outbox, 'f.txt'), 'f');
  await env.svc.handle({ t: 'fs-get', id: 3, path: '/Outbox/f.txt' }); // a download, not an upload
  env.svc.onChunk(3, true, Buffer.from('evil'));
  assert.deepEqual(fs.readdirSync(env.inbox), []);
  assert.equal(env.sent.some((m) => m.t === 'fs-done'), false);
});

test('only a few transfers may run at once', async () => {
  const env = setup();
  for (let i = 1; i <= 4; i++) await env.svc.handle({ t: 'fs-put', id: i, name: `f${i}.bin`, size: 10 });
  await env.svc.handle({ t: 'fs-put', id: 5, name: 'f5.bin', size: 10 });
  assert.equal(env.sent.at(-1).reason, 'busy');
  await env.svc.handle({ t: 'fs-put', id: 1, name: 'dup.bin', size: 10 }); // id already in use
  assert.equal(env.sent.at(-1).reason, 'busy');
  env.svc.dispose();
});

// Runs the viewer's clipboard/file UI (viewer/extras.js) against a tiny fake DOM, so that typos
// and logic errors in code that otherwise only a browser can execute are caught here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// The page imports '/transfer.js' (a URL path served by the relay); map it to the file here.
register(
  'data:text/javascript,' +
    encodeURIComponent(`
      let target;
      export async function initialize(data) { target = data.target; }
      export async function resolve(specifier, context, next) {
        if (specifier === '/transfer.js') return { url: target, shortCircuit: true };
        return next(specifier, context);
      }`),
  { data: { target: new URL('../viewer/transfer.js', import.meta.url).href } },
);

/** Just enough DOM for extras.js. */
class FakeNode {
  constructor(tag = 'div') {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.attrs = {};
    this.hidden = false;
    this.textContent = '';
    this.value = '';
    this.files = [];
    this.className = '';
    this.classList = {
      set: new Set(),
      add: (c) => this.classList.set.add(c),
      toggle: (c, on) => (on ? this.classList.set.add(c) : this.classList.set.delete(c)),
      contains: (c) => this.classList.set.has(c),
    };
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  // Like a browser: listeners are called, their returned promises are not awaited.
  async fire(type, event = {}) {
    for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {}, target: this, ...event });
    await new Promise((r) => setTimeout(r, 0));
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  prepend(...nodes) {
    this.children.unshift(...nodes);
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  remove() {
    this.removed = true;
  }
  click() {
    this.clicked = true;
  }
  /** all descendants */
  all() {
    return this.children.flatMap((c) => [c, ...(c.all ? c.all() : [])]);
  }
}

function setup({ clipboard = {} } = {}) {
  const ids = ['clipBtn', 'clipPending', 'filesBtn', 'files', 'filesClose', 'crumb', 'entries', 'transferList', 'filesHint', 'upload', 'uploadLabel', 'stage', 'dropHint'];
  const nodes = Object.fromEntries(ids.map((id) => [id, new FakeNode(id.startsWith('upload') && id === 'upload' ? 'input' : 'div')]));
  for (const id of ['clipPending', 'filesBtn', 'files', 'dropHint', 'clipBtn']) nodes[id].hidden = true;
  const written = [];
  const store = {};
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (t) => {
          if (clipboard.writeFails) throw new Error('NotAllowedError');
          written.push(t);
        },
        readText: async () => {
          if (clipboard.readFails) throw new Error('denied');
          return clipboard.text ?? 'texte local';
        },
      },
    },
  });
  globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => (store[k] = v) };
  globalThis.document = { createElement: (tag) => new FakeNode(tag), body: new FakeNode('body') };
  globalThis.window = {};
  return { nodes, written, store, $: (id) => nodes[id] };
}

const sent = () => {
  const out = [];
  return { out, sendJson: (m) => out.push(m), sendChunk: (id, last, bytes) => out.push({ chunk: { id, last, n: bytes.length } }), bufferedAmount: () => 0 };
};

async function loadExtras() {
  // a fresh module instance per test (it registers listeners at creation)
  return import(`../viewer/extras.js?${Math.random()}`);
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const PERM = { t: 'perm', clipboard: true, files: 'ask', roots: [{ name: 'Inbox', read: true, write: true }, { name: 'Outbox', read: true, write: false }] };

test('buttons appear only for what the host allows', async () => {
  const env = setup();
  const { createExtras } = await loadExtras();
  const x = createExtras(env.$);
  const io = sent();
  x.start(io);
  assert.equal(x.onJson({ t: 'perm', clipboard: false, files: 'deny', roots: [] }), true);
  assert.equal(env.nodes.clipBtn.hidden, true);
  assert.equal(env.nodes.filesBtn.hidden, true);

  x.onJson(PERM);
  assert.equal(env.nodes.clipBtn.hidden, false);
  assert.equal(env.nodes.filesBtn.hidden, false);

  x.onJson({ t: 'perm', clipboard: true, files: 'allow', roots: [] }); // no folder to show
  assert.equal(env.nodes.filesBtn.hidden, true);
  x.stop();
  assert.equal(env.nodes.clipBtn.hidden, true);
});

test('the files panel lists roots, opens folders and offers downloads', async () => {
  const env = setup();
  const { createExtras } = await loadExtras();
  const x = createExtras(env.$);
  const io = sent();
  x.start(io);
  x.onJson(PERM);

  await env.nodes.filesBtn.fire('click');
  assert.equal(env.nodes.files.hidden, false);
  const req = io.out.at(-1);
  assert.deepEqual([req.t, req.path], ['fs-list', '/']);

  x.onJson({ t: 'fs-list-r', id: req.id, path: '/', entries: [{ name: 'Inbox', dir: true, size: 0 }, { name: 'Outbox', dir: true, size: 0 }] });
  await tick();
  assert.equal(env.nodes.entries.children.length, 2);

  // open Outbox through its button
  const outboxButton = env.nodes.entries.children[1].all().find((n) => n.tag === 'button');
  await outboxButton.fire('click');
  const req2 = io.out.at(-1);
  assert.deepEqual([req2.t, req2.path], ['fs-list', '/Outbox']);

  x.onJson({ t: 'fs-list-r', id: req2.id, path: '/Outbox', entries: [{ name: 'rapport.pdf', dir: false, size: 2048 }] });
  await tick();
  const rows = env.nodes.entries.children;
  assert.equal(rows.length, 2, 'parent link + one file');
  const buttons = rows[1].all().filter((n) => n.tag === 'button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].textContent, 'Télécharger');
  assert.match(env.nodes.filesHint.textContent, /Inbox/);

  // a listing error is shown, not thrown
  await env.nodes.filesBtn.fire('click'); // close
  await env.nodes.filesBtn.fire('click'); // open again -> list
  const req3 = io.out.at(-1);
  x.onJson({ t: 'fs-error', id: req3.id, reason: 'not-allowed' });
  await tick();
  assert.equal(env.nodes.filesHint.classList.contains('error'), true);
  assert.match(env.nodes.filesHint.textContent, /partagé/);
});

test('upload from the picker sends the request, then chunks after the host agrees', async () => {
  const env = setup();
  const { createExtras } = await loadExtras();
  const x = createExtras(env.$);
  const io = sent();
  x.start(io);
  x.onJson(PERM);

  env.nodes.upload.files = [new File([Buffer.alloc(70_000, 1)], 'gros.bin')];
  await env.nodes.upload.fire('change');
  await tick();
  const put = io.out.find((m) => m.t === 'fs-put');
  assert.deepEqual([put.name, put.size, put.dir], ['gros.bin', 70_000, '/Inbox']);
  assert.equal(io.out.some((m) => m.chunk), false, 'no data before the host answers');

  x.onJson({ t: 'fs-put-r', id: put.id, name: 'gros.bin', path: '/Inbox/gros.bin' });
  await new Promise((r) => setTimeout(r, 30));
  const chunks = io.out.filter((m) => m.chunk).map((m) => m.chunk);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.at(-1).last, true);
  assert.equal(chunks.reduce((n, c) => n + c.n, 0), 70_000);

  x.onJson({ t: 'fs-done', id: put.id, name: 'gros.bin', size: 70_000, path: '/Inbox/gros.bin' });
  await tick();
  const row = env.nodes.transferList.children[0];
  assert.match(row.all().map((n) => n.textContent).join(' '), /envoyé/);
});

test('a refused upload is shown as an error row', async () => {
  const env = setup();
  const { createExtras } = await loadExtras();
  const x = createExtras(env.$);
  const io = sent();
  x.start(io);
  x.onJson(PERM);
  env.nodes.upload.files = [new File(['x'], 'a.txt')];
  await env.nodes.upload.fire('change');
  const put = io.out.find((m) => m.t === 'fs-put');
  x.onJson({ t: 'fs-error', id: put.id, reason: 'refused' });
  await tick();
  const row = env.nodes.transferList.children[0];
  assert.equal(row.classList.contains('error'), true);
  assert.match(row.all().map((n) => n.textContent).join(' '), /refusé/);
});

test('drag and drop onto the screen uploads, but only when files are enabled', async () => {
  const env = setup();
  const { createExtras } = await loadExtras();
  const x = createExtras(env.$);
  const io = sent();
  x.start(io);
  const dt = { types: ['Files'], files: [new File(['abc'], 'depot.txt')] };

  await env.nodes.stage.fire('drop', { dataTransfer: dt });
  assert.equal(io.out.some((m) => m.t === 'fs-put'), false, 'ignored before the host announced permissions');

  x.onJson(PERM);
  await env.nodes.stage.fire('dragover', { dataTransfer: dt });
  assert.equal(env.nodes.dropHint.hidden, false);
  await env.nodes.stage.fire('drop', { dataTransfer: dt });
  assert.equal(env.nodes.dropHint.hidden, true);
  assert.equal(io.out.some((m) => m.t === 'fs-put' && m.name === 'depot.txt'), true);

  x.onJson({ t: 'perm', clipboard: false, files: 'deny', roots: [] });
  io.out.length = 0;
  await env.nodes.stage.fire('drop', { dataTransfer: dt });
  assert.deepEqual(io.out, []);
});

test('remote clipboard text is written locally, or offered on a button when the browser refuses', async () => {
  const ok = setup();
  let { createExtras } = await loadExtras();
  let x = createExtras(ok.$);
  x.start(sent());
  x.onJson(PERM);
  x.onJson({ t: 'clip', text: 'copié là-bas' });
  await tick();
  assert.deepEqual(ok.written, ['copié là-bas']);
  assert.equal(ok.nodes.clipPending.hidden, true);

  const refused = setup({ clipboard: { writeFails: true } });
  ({ createExtras } = await loadExtras());
  x = createExtras(refused.$);
  x.start(sent());
  x.onJson(PERM);
  x.onJson({ t: 'clip', text: 'à copier' });
  await tick();
  assert.equal(refused.nodes.clipPending.hidden, false, 'a click is needed');
});

test('clipboard sync can be switched off, and the choice is remembered', async () => {
  const env = setup();
  const { createExtras } = await loadExtras();
  const x = createExtras(env.$);
  x.start(sent());
  x.onJson(PERM);
  assert.equal(await x.localClipboardForPaste(), 'texte local');

  await env.nodes.clipBtn.fire('click');
  assert.equal(env.nodes.clipBtn.attrs['aria-pressed'], 'false');
  assert.equal(env.store['bifrost.clip'], '0');
  assert.equal(await x.localClipboardForPaste(), null, 'nothing is pushed to the host when off');
  x.onJson({ t: 'clip', text: 'ignored' });
  await tick();
  assert.deepEqual(env.written, []);
});

test('remote paste waits for the host acknowledgement (or gives up)', async () => {
  const env = setup();
  const { createExtras } = await loadExtras();
  const x = createExtras(env.$);
  x.start(sent());
  x.onJson(PERM);

  let acked = false;
  const waiting = x.waitClipboardAck(1000).then((v) => (acked = v));
  await tick();
  assert.equal(acked, false);
  x.onJson({ t: 'clip-set', ok: true });
  await waiting;
  assert.equal(acked, true);

  assert.equal(await x.waitClipboardAck(30), false, 'times out when the host never answers');
});

test('a clipboard the browser cannot read is simply skipped', async () => {
  const env = setup({ clipboard: { readFails: true } });
  const { createExtras } = await loadExtras();
  const x = createExtras(env.$);
  x.start(sent());
  x.onJson(PERM);
  assert.equal(await x.localClipboardForPaste(), null);
});

test('stop() cancels pending transfers and hides everything', async () => {
  const env = setup();
  const { createExtras } = await loadExtras();
  const x = createExtras(env.$);
  const io = sent();
  x.start(io);
  x.onJson(PERM);
  env.nodes.upload.files = [new File(['x'], 'pending.txt')];
  await env.nodes.upload.fire('change');
  x.stop();
  await tick();
  const row = env.nodes.transferList.children;
  assert.equal(row.length, 0);
  assert.equal(x.onJson({ t: 'clip', text: 'late' }), false, 'ignored once the session is over');
});

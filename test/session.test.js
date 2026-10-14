import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MIN_ITERATIONS, deriveKey, randomB64, toB64 } from '../shared/auth.js';
import {
  KIND_FILE,
  KIND_FRAME,
  KIND_JSON,
  KIND_VIDEO,
  ViewerE2E,
  commitmentOf,
  newEphemeral,
  packFileBody,
  parseJsonBody,
  unpackFileBody,
  unpackFrameBody,
  unpackVideoBody,
} from '../shared/e2e.js';
import { PasswordGuard, Session, sanitizeLabel } from '../agent/session.js';
import { lookupKey } from '../agent/keymap.js';
import { FrameParser } from '../agent/frames.js';

const ID = '482913075';
const PERM_OFF = { t: 'perm', clipboard: false, files: 'deny', roots: [] };
const tick = () => new Promise((r) => setImmediate(r));

/** WebCrypto work is truly asynchronous: wait for a condition instead of guessing a delay. */
async function waitFor(condition, what = 'condition') {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function configWithPassword(password, extra = {}) {
  const passwordSalt = randomB64(16);
  const key = await deriveKey(password, passwordSalt, MIN_ITERATIONS);
  return { id: ID, passwordSalt, passwordIters: MIN_ITERATIONS, passwordKey: toB64(key), ...extra };
}

/** A Session wired to fake OS helpers. */
function harness({ config, consent = true, guard = new PasswordGuard(), adaptIntervalMs = 60_000, keyframeMinIntervalMs = 0, permissions }) {
  const sent = []; // plaintext JSON toward the viewer
  const binary = []; // encrypted packets toward the viewer
  const events = {
    input: [], captureStarted: 0, indicator: null, ended: null, consentAsked: 0, consentText: '',
    keyRequests: 0, bitrates: [], captureOptions: null,
    clipboardStarted: 0, clipboardSet: [], clipboardChange: null, consentTexts: [],
    monitorRequests: [], onMonitors: null,
  };
  let buffered = 0;
  const helpers = {
    startClipboard: ({ onChange, onSet }) => {
      events.clipboardStarted += 1;
      events.clipboardChange = onChange;
      events.clipboardAck = onSet;
      return { set: (t) => events.clipboardSet.push(t), stop() {} };
    },
    askConsent: ({ text }) => {
      events.consentAsked += 1;
      events.consentText = text;
      events.consentTexts.push(text);
      return { promise: Promise.resolve(consent), cancel() {} };
    },
    startInput: () => ({ send: (l) => events.input.push(l), stop() {} }),
    startCapture: (o) => {
      events.captureStarted += 1;
      events.onFrame = o.onFrame;
      events.captureOptions = o;
      events.onMonitors = o.onMonitors;
      return {
        stop() {},
        requestKeyframe: () => (events.keyRequests += 1),
        setBitrate: (b) => events.bitrates.push(b),
        setMonitor: (i) => events.monitorRequests.push(i),
      };
    },
    showIndicator: (o) => {
      events.indicator = o;
      return { stop() {} };
    },
  };
  const session = new Session({
    send: (m) => sent.push(m),
    sendBinary: (b) => binary.push(b),
    bufferedAmount: () => buffered,
    peerIp: '203.0.113.9',
    config,
    helpers,
    guard,
    adaptIntervalMs,
    keyframeMinIntervalMs,
    ...(permissions ? { permissions } : {}),
    onEnd: (r) => (events.ended = r),
  });
  return { session, sent, binary, events, guard, setBuffered: (n) => (buffered = n) };
}

/** Plays the viewer side of the handshake against a session. */
async function connect({ config, consent, guard, password = '', mode = 'control', label = 'Nathan', codecs = ['jpeg'], adaptIntervalMs, permissions }) {
  const h = harness({ config, consent, guard, adaptIntervalMs, permissions });
  h.session.begin();
  const challenge = h.sent.find((m) => m.t === 'challenge');
  const viewer = new ViewerE2E({ id: config.id, password });
  await h.session.onMessage(await viewer.commitMessage());
  const key = h.sent.find((m) => m.t === 'hello-key');
  const auth = await viewer.authMessage({ challenge, hpub: key.hpub, mode, label, codecs });
  await h.session.onMessage(auth);
  await tick();

  let consumed = 0;
  return {
    ...h,
    viewer,
    challenge,
    /** Decrypts everything the host sent since the last call. */
    async receive() {
      const out = [];
      while (consumed < h.binary.length) {
        const { kind, body } = await viewer.channel.open(new Uint8Array(h.binary[consumed++]));
        if (kind === KIND_FRAME) out.push({ frame: unpackFrameBody(body) });
        else if (kind === KIND_VIDEO) out.push({ video: unpackVideoBody(body) });
        else if (kind === KIND_FILE) out.push({ file: unpackFileBody(body) });
        else out.push(parseJsonBody(body));
      }
      return out;
    },
    async input(obj) {
      await h.session.onBinary(await viewer.channel.sealJson(obj));
    },
    async chunk(id, last, data) {
      await h.session.onBinary(await viewer.channel.seal(KIND_FILE, packFileBody(id, last, data)));
    },
  };
}

test('valid password grants access without asking, and the viewer sees "accepted"', async () => {
  const config = await configWithPassword('s3cret-pass');
  const c = await connect({ config, password: 's3cret-pass' });
  assert.equal(c.challenge.hasPassword, true);
  assert.equal(c.events.consentAsked, 0);
  assert.deepEqual(await c.receive(), [{ t: 'accepted', mode: 'control' }, PERM_OFF]);
  assert.ok(c.events.indicator, 'indicator must always be shown');
  assert.equal(c.events.captureStarted, 1);
});

test('requireConsent asks even with a correct password; refusing stops everything', async () => {
  const config = await configWithPassword('s3cret-pass', { requireConsent: true });
  const c = await connect({ config, password: 's3cret-pass', consent: false });
  assert.equal(c.events.consentAsked, 1);
  assert.deepEqual(await c.receive(), [{ t: 'waiting-consent' }, { t: 'denied', reason: 'refused' }]);
  assert.equal(c.events.captureStarted, 0);
  assert.deepEqual(c.sent.at(-1), { t: 'leave' });
});

test('wrong password is denied; 5 failures lock the password path', async () => {
  const config = await configWithPassword('s3cret-pass');
  const guard = new PasswordGuard();
  for (let i = 0; i < 5; i++) {
    const c = await connect({ config, guard, password: 'wrong-pass-' + i });
    assert.deepEqual(c.sent.find((m) => m.t === 'denied'), { t: 'denied', reason: 'bad_password' });
    assert.equal(c.events.captureStarted, 0);
  }
  assert.equal(guard.locked, true);

  const c = await connect({ config, guard, password: 's3cret-pass' });
  assert.deepEqual(c.sent.find((m) => m.t === 'denied'), { t: 'denied', reason: 'locked' });
  assert.equal(c.events.captureStarted, 0);
});

test('consent mode shows the same verification code to the host and the viewer', async () => {
  const c = await connect({ config: { id: ID }, consent: true });
  assert.equal(c.events.consentAsked, 1);
  assert.match(c.viewer.sas, /^\d{6}$/);
  const spaced = `${c.viewer.sas.slice(0, 3)} ${c.viewer.sas.slice(3)}`;
  assert.ok(c.events.consentText.includes(spaced), 'dialog must show the code the viewer sees');
  assert.equal(c.viewer.usedPassword, false);
  assert.deepEqual(await c.receive(), [{ t: 'waiting-consent' }, { t: 'accepted', mode: 'control' }, PERM_OFF]);
});

test('typing a password for a host that has none falls back to consent', async () => {
  const c = await connect({ config: { id: ID }, password: 'whatever-123' });
  assert.equal(c.challenge.hasPassword, false);
  assert.equal(c.events.consentAsked, 1);
});

test('a forged "password" flag on a host without password is refused', async () => {
  const h = harness({ config: { id: ID } });
  h.session.begin();
  const viewer = new ViewerE2E({ id: ID });
  await h.session.onMessage(await viewer.commitMessage());
  const key = h.sent.find((m) => m.t === 'hello-key');
  const auth = await viewer.authMessage({ challenge: h.sent[0], hpub: key.hpub, mode: 'control', label: 'x' });
  await h.session.onMessage({ ...auth, pw: true });
  assert.deepEqual(h.sent.find((m) => m.t === 'denied'), { t: 'denied', reason: 'no_password' });
  assert.equal(h.events.captureStarted, 0);
});

test('view-only sessions never start the input injector or accept input', async () => {
  const c = await connect({ config: { id: ID }, mode: 'view' });
  await c.input({ t: 'mv', x: 0.5, y: 0.5 });
  await c.input({ t: 'tx', ch: 'a' });
  assert.deepEqual(c.events.input, []);
  assert.equal(c.events.captureStarted, 1);
});

test('input messages are validated and translated', async () => {
  const c = await connect({ config: { id: ID } });
  const inputs = [
    { t: 'mv', x: 2, y: -1 }, // clamped
    { t: 'mv', x: 'a', y: 0 }, // rejected
    { t: 'md', b: 'l', x: 0.25, y: 0.75 },
    { t: 'mu', b: 'l' }, // no coordinates: no move
    { t: 'md', b: 'z', x: 0, y: 0 }, // unknown button
    { t: 'wh', dx: 0, dy: 99999 },
    { t: 'kd', code: 'ArrowLeft' },
    { t: 'ku', code: 'ArrowLeft' },
    { t: 'kd', code: 'Nonexistent' },
    { t: 'tx', ch: 'é' },
    { t: 'tx', ch: 'x'.repeat(50) },
  ];
  for (const m of inputs) await c.input(m);

  assert.deepEqual(c.events.input, [
    'm 1.00000 0.00000',
    'm 0.25000 0.75000',
    'b l d',
    'b l u',
    'w 1200',
    'k 75 1 d',
    'k 75 1 u',
    `u ${'é'.charCodeAt(0)}`,
  ]);
});

test('frames are encrypted, unchanged screens are skipped, dropped frames keep counters contiguous', async () => {
  const c = await connect({ config: { id: ID }, mode: 'view' });
  await c.receive(); // handshake replies
  const base = c.binary.length;

  const jpeg = (data) => ({ kind: 'jpeg', key: true, width: 800, height: 600, data });
  const a = Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]);
  c.events.onFrame(jpeg(a));
  c.events.onFrame(jpeg(Buffer.from(a))); // same bytes: skipped
  c.setBuffered(10 * 1024 * 1024);
  c.events.onFrame(jpeg(Buffer.from([0xff, 0xd8, 2, 0xff, 0xd9]))); // slow link: dropped
  c.setBuffered(0);
  c.events.onFrame(jpeg(Buffer.from([0xff, 0xd8, 3, 0xff, 0xd9])));
  await waitFor(() => c.binary.length >= base + 2, 'two encrypted frames');
  await tick();

  const got = await c.receive(); // would throw on a counter gap
  assert.equal(got.length, 2);
  assert.equal(got[0].frame.width, 800);
  assert.equal(got[0].frame.height, 600);
  assert.deepEqual([...got[0].frame.jpeg], [...a]);
  assert.equal(Buffer.from(c.binary[0]).includes(Buffer.from([0xff, 0xd8, 1])), false, 'JPEG must not appear in clear');
});

test('codec negotiation: H.264 only when the viewer offers it', async () => {
  const both = await connect({ config: { id: ID }, mode: 'view', codecs: ['h264', 'jpeg'] });
  assert.equal(both.events.captureOptions.codec, 'h264');
  const jpegOnly = await connect({ config: { id: ID }, mode: 'view', codecs: ['jpeg'] });
  assert.equal(jpegOnly.events.captureOptions.codec, 'jpeg');
  const garbage = await connect({ config: { id: ID }, mode: 'view', codecs: ['vp9', 42, null] });
  assert.equal(garbage.events.captureOptions.codec, 'jpeg');
});

test('H.264 frames reach the viewer encrypted, with keyframe flag and size', async () => {
  const c = await connect({ config: { id: ID }, mode: 'view', codecs: ['h264'] });
  await c.receive();
  const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x4d, 0x40, 0x1f, 0xaa]);
  const idr = Buffer.concat([sps, Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3])]);
  const p = Buffer.from([0, 0, 0, 1, 0x41, 9, 9]);
  const base = c.binary.length;
  c.events.onFrame({ kind: 'h264', key: true, width: 1920, height: 1080, data: idr });
  c.events.onFrame({ kind: 'h264', key: false, width: 1920, height: 1080, data: p });
  await waitFor(() => c.binary.length >= base + 2, 'two encrypted video packets');

  const got = await c.receive();
  assert.equal(got.length, 2);
  assert.equal(got[0].video.key, true);
  assert.equal(got[0].video.width, 1920);
  assert.equal(got[0].video.height, 1080);
  assert.deepEqual([...got[0].video.data], [...idr]);
  assert.equal(got[1].video.key, false);
  assert.equal(Buffer.from(c.binary[base]).includes(Buffer.from([0x67, 0x4d, 0x40])), false, 'SPS must not appear in clear');
});

test('H.264 never starts, or resumes after a drop, on a delta frame', async () => {
  const c = await connect({ config: { id: ID }, mode: 'view', codecs: ['h264'] });
  await c.receive();
  const key = (n) => ({ kind: 'h264', key: true, width: 640, height: 480, data: Buffer.from([0, 0, 0, 1, 0x65, n]) });
  const delta = (n) => ({ kind: 'h264', key: false, width: 640, height: 480, data: Buffer.from([0, 0, 0, 1, 0x41, n]) });
  const base = c.binary.length; // handshake replies already delivered
  const sentCount = () => c.binary.length - base;

  c.events.onFrame(delta(1)); // nothing decodable yet
  assert.equal(sentCount(), 0);
  assert.ok(c.events.keyRequests >= 1, 'a keyframe was requested');

  c.events.onFrame(key(2));
  c.events.onFrame(delta(3));
  await waitFor(() => sentCount() === 2, 'key + delta');

  // The link stalls: this delta is dropped, so the stream is broken...
  c.setBuffered(10 * 1024 * 1024);
  const before = c.events.keyRequests;
  c.events.onFrame(delta(4));
  c.setBuffered(0);
  // ...and later deltas must NOT be sent (the viewer could not decode them).
  c.events.onFrame(delta(5));
  c.events.onFrame(delta(6));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sentCount(), 2, 'no delta frames after a drop');
  assert.ok(c.events.keyRequests > before, 'a keyframe was requested after the drop');

  // The next keyframe resynchronizes the stream.
  c.events.onFrame(key(7));
  c.events.onFrame(delta(8));
  await waitFor(() => sentCount() === 4, 'resync key + delta');
  const got = await c.receive();
  assert.deepEqual(got.map((m) => m.video.key), [true, false, true, false]);
});

test('the bitrate drops after congestion and recovers on a healthy link', async () => {
  const c = await connect({ config: { id: ID }, mode: 'view', codecs: ['h264'], adaptIntervalMs: 25 });
  await c.receive();
  const key = { kind: 'h264', key: true, width: 640, height: 480, data: Buffer.from([0, 0, 0, 1, 0x65, 1]) };
  const delta = { kind: 'h264', key: false, width: 640, height: 480, data: Buffer.from([0, 0, 0, 1, 0x41, 1]) };
  c.events.onFrame(key);
  c.setBuffered(10 * 1024 * 1024);
  c.events.onFrame(delta); // congestion
  c.setBuffered(0);

  await waitFor(() => c.events.bitrates.length >= 1, 'bitrate reduction');
  const reduced = c.events.bitrates[0];
  assert.ok(reduced < 4_000_000 && reduced >= 600_000, `reduced to ${reduced}`);
  await waitFor(() => c.events.bitrates.at(-1) > reduced, 'bitrate recovery');
  assert.ok(c.events.bitrates.at(-1) <= 4_000_000);
});

test('the stream falls back to JPEG when the viewer cannot decode H.264', async () => {
  const c = await connect({ config: { id: ID }, mode: 'view', codecs: ['h264', 'jpeg'] });
  await c.receive();
  assert.equal(c.events.captureOptions.codec, 'h264');
  const firstCapture = c.events.captureOptions;
  const stopped = [];
  // observe that the old helper is stopped, without ending the session
  c.session.parts.capture.stop = () => stopped.push('h264 helper');

  await c.input({ t: 'codec', codec: 'jpeg' });
  assert.deepEqual(stopped, ['h264 helper']);
  assert.notEqual(c.events.captureOptions, firstCapture, 'a new helper was started');
  assert.equal(c.events.captureOptions.codec, 'jpeg');
  assert.equal(c.events.ended, null, 'the session goes on');

  // The replaced helper may still emit frames or exit: neither must matter.
  firstCapture.onFrame({ kind: 'h264', key: true, width: 640, height: 480, data: Buffer.from([0, 0, 0, 1, 0x65, 1]) });
  firstCapture.onExit(0);
  assert.equal(c.events.ended, null);

  // And the new helper's JPEG frames flow.
  const base = c.binary.length;
  c.events.captureOptions.onFrame({ kind: 'jpeg', key: true, width: 640, height: 480, data: Buffer.from([0xff, 0xd8, 9, 0xff, 0xd9]) });
  await waitFor(() => c.binary.length > base, 'jpeg frame after fallback');
  const got = await c.receive();
  assert.deepEqual(got.map((m) => Boolean(m.frame)), [true]);
});

function sharedFolders() {
  const inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-s-in-'));
  const outbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-s-out-'));
  return {
    inbox,
    outbox,
    roots: [
      { name: 'Inbox', dir: inbox, read: true, write: true },
      { name: 'Outbox', dir: outbox, read: true, write: false },
    ],
  };
}

test('permissions are announced to the viewer; defaults are all off', async () => {
  const dirs = sharedFolders();
  const on = await connect({
    config: { id: ID },
    permissions: { clipboard: true, fileTransfer: 'ask', roots: dirs.roots },
  });
  const got = await on.receive();
  assert.deepEqual(got.at(-1), {
    t: 'perm',
    clipboard: true,
    files: 'ask',
    roots: [{ name: 'Inbox', read: true, write: true }, { name: 'Outbox', read: true, write: false }],
  });
  assert.equal(JSON.stringify(got).includes(dirs.inbox), false, 'real folders are not disclosed');

  const off = await connect({ config: { id: ID } }); // no permissions given
  assert.deepEqual((await off.receive()).at(-1), PERM_OFF);
  assert.equal(off.events.clipboardStarted, 0);
});

test('folders are created only once a person is accepted with file transfer on', async () => {
  const dirs = sharedFolders();
  let created = 0;
  const permissions = { clipboard: false, fileTransfer: 'allow', roots: dirs.roots, ensureDirs: () => (created += 1) };

  // wrong password: nothing happens on the PC
  const config = await configWithPassword('s3cret-pass');
  const bad = await connect({ config, password: 'wrong-pass-123', permissions });
  assert.ok(bad.sent.some((m) => m.t === 'denied'));
  assert.equal(created, 0);

  // accepted but view-only: still nothing
  await connect({ config: { id: ID }, mode: 'view', permissions });
  assert.equal(created, 0);

  // accepted in control mode: now the folders are made, once
  await connect({ config: { id: ID }, mode: 'control', permissions });
  assert.equal(created, 1);
});

test('view-only: no clipboard bridge, no file service, such messages are ignored', async () => {
  const dirs = sharedFolders();
  const c = await connect({
    config: { id: ID },
    mode: 'view',
    permissions: { clipboard: true, fileTransfer: 'allow', roots: dirs.roots },
  });
  assert.deepEqual((await c.receive()).at(-1), PERM_OFF);
  assert.equal(c.events.clipboardStarted, 0);
  await c.input({ t: 'clip', text: 'x' });
  await c.input({ t: 'fs-put', id: 1, name: 'a.txt', size: 1 });
  await c.input({ t: 'fs-list', id: 2, path: '/' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(c.events.clipboardSet, []);
  assert.deepEqual(fs.readdirSync(dirs.inbox), []);
  assert.deepEqual(await c.receive(), [], 'no replies of any kind');
});

test('clipboard: viewer to host, host to viewer, size-limited, and switchable', async () => {
  const c = await connect({ config: { id: ID }, permissions: { clipboard: true, fileTransfer: 'deny', roots: [] } });
  await c.receive();
  assert.equal(c.events.clipboardStarted, 1);

  await c.input({ t: 'clip', text: 'bonjour é 😀' });
  assert.deepEqual(c.events.clipboardSet, ['bonjour é 😀']);
  await c.input({ t: 'clip', text: 'x'.repeat(600 * 1024) }); // over the cap
  await c.input({ t: 'clip', text: 42 });
  assert.equal(c.events.clipboardSet.length, 1);

  const base = c.binary.length;
  c.events.clipboardChange('copié sur le PC distant');
  c.events.clipboardChange('y'.repeat(600 * 1024)); // too large to forward
  await waitFor(() => c.binary.length >= base + 1, 'clipboard packet');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(await c.receive(), [{ t: 'clip', text: 'copié sur le PC distant' }]);

  // The host confirms when the text is really on its clipboard (the viewer waits for it
  // before sending Ctrl+V).
  const before = c.binary.length;
  c.events.clipboardAck(true);
  await waitFor(() => c.binary.length > before, 'clip-set');
  assert.deepEqual(await c.receive(), [{ t: 'clip-set', ok: true }]);

  const off = await connect({ config: { id: ID }, permissions: { clipboard: false, fileTransfer: 'deny', roots: [] } });
  assert.equal(off.events.clipboardStarted, 0);
  await off.input({ t: 'clip', text: 'nope' });
  assert.deepEqual(off.events.clipboardSet, []);
});

test('files: upload through the encrypted channel lands in the shared folder', async () => {
  const dirs = sharedFolders();
  const c = await connect({ config: { id: ID }, permissions: { clipboard: false, fileTransfer: 'allow', roots: dirs.roots } });
  await c.receive();
  const payload = Buffer.alloc(70_000, 5);

  await c.input({ t: 'fs-put', id: 7, name: 'rapport.bin', size: payload.length, dir: '/Inbox' });
  await waitFor(() => c.binary.length > 3, 'fs-put-r');
  const ready = (await c.receive()).find((m) => m.t === 'fs-put-r');
  assert.equal(ready.id, 7);
  assert.equal(ready.path, '/Inbox/rapport.bin');

  for (let off = 0; off < payload.length; off += 32 * 1024) {
    const part = payload.subarray(off, off + 32 * 1024);
    await c.chunk(7, off + 32 * 1024 >= payload.length, part);
  }
  await waitFor(() => c.binary.length > 4, 'fs-done');
  const done = (await c.receive()).find((m) => m.t === 'fs-done');
  assert.deepEqual([done.id, done.name, done.size], [7, 'rapport.bin', payload.length]);
  assert.deepEqual(fs.readFileSync(path.join(dirs.inbox, 'rapport.bin')), payload);
});

test('files: download chunks arrive encrypted and complete', async () => {
  const dirs = sharedFolders();
  const data = Buffer.alloc(100_000, 8);
  fs.writeFileSync(path.join(dirs.outbox, 'export.bin'), data);
  const c = await connect({ config: { id: ID }, permissions: { clipboard: false, fileTransfer: 'allow', roots: dirs.roots } });
  await c.receive();
  const base = c.binary.length;

  await c.input({ t: 'fs-get', id: 3, path: '/Outbox/export.bin' });
  await waitFor(() => c.binary.length >= base + 5, 'get reply and 4 chunks'); // 100000 / 32768 -> 4 chunks
  const got = await c.receive();
  assert.deepEqual([got[0].t, got[0].name, got[0].size], ['fs-get-r', 'export.bin', data.length]);
  const chunks = got.filter((m) => m.file).map((m) => m.file);
  assert.ok(chunks.every((k) => k.id === 3));
  assert.equal(chunks.at(-1).last, true);
  assert.deepEqual(Buffer.concat(chunks.map((k) => Buffer.from(k.data))), data);
  for (const p of c.binary) assert.equal(Buffer.from(p).includes(Buffer.alloc(64, 8)), false, 'file content not in clear');
});

test('files: "ask" shows the dialog, and a refusal transfers nothing', async () => {
  const dirs = sharedFolders();
  // The connection itself is accepted; only the later file dialog is answered "no".
  const ok = await connect({ config: { id: ID }, consent: true, permissions: { clipboard: false, fileTransfer: 'ask', roots: dirs.roots } });
  await ok.receive();
  const connectionDialogs = ok.events.consentTexts.length;
  ok.session.helpers.askConsent = ({ text }) => {
    ok.events.consentTexts.push(text);
    return { promise: Promise.resolve(false), cancel() {} };
  };
  await ok.input({ t: 'fs-put', id: 1, name: 'x.bin', size: 3, dir: '/Inbox' });
  await waitFor(() => ok.events.consentTexts.length > connectionDialogs, 'file dialog');
  assert.match(ok.events.consentTexts.at(-1), /x\.bin/);
  await waitFor(async () => (await ok.receive()).some((m) => m.t === 'fs-error' && m.reason === 'refused'), 'refusal');
  assert.deepEqual(fs.readdirSync(dirs.inbox), []);
});

test('a tampered file chunk ends the session and writes nothing', async () => {
  const dirs = sharedFolders();
  const c = await connect({ config: { id: ID }, permissions: { clipboard: false, fileTransfer: 'allow', roots: dirs.roots } });
  await c.receive();
  await c.input({ t: 'fs-put', id: 1, name: 'evil.bin', size: 10, dir: '/Inbox' });
  await waitFor(() => c.binary.length > 3, 'fs-put-r');
  const packet = await c.viewer.channel.seal(KIND_FILE, packFileBody(1, true, Buffer.alloc(10, 1)));
  const bad = Uint8Array.from(packet);
  bad[bad.length - 3] ^= 0x10;
  await c.session.onBinary(bad);
  assert.equal(c.events.ended, 'crypto-error');
  assert.equal(fs.existsSync(path.join(dirs.inbox, 'evil.bin')), false);
  assert.equal(fs.readdirSync(dirs.inbox).filter((n) => !n.endsWith('.bifrost-part')).length, 0);
});

const TWO_SCREENS = {
  current: 0,
  list: [
    { x: 0, y: 0, w: 2560, h: 1440, primary: true },
    { x: -1920, y: 0, w: 1920, h: 1080, primary: false },
  ],
};

test('displays: the viewer is told what exists, sizes only, and the pointer follows the chosen one', async () => {
  const c = await connect({ config: { id: ID }, mode: 'control', codecs: ['h264'] });
  await c.receive();
  const base = c.binary.length;
  c.events.onMonitors(TWO_SCREENS);
  await waitFor(() => c.binary.length > base, 'monitors message');
  assert.deepEqual((await c.receive()).filter((m) => m.t === 'monitors'), [
    {
      t: 'monitors',
      current: 0,
      list: [
        { w: 2560, h: 1440, primary: true },
        { w: 1920, h: 1080, primary: false },
      ],
    },
  ]);
  assert.equal(c.events.input.at(-1), 'r 0 0 2560 1440');

  // The viewer picks the second display: the helper is asked, nothing else changes yet.
  await c.input({ t: 'mon', i: 1 });
  assert.deepEqual(c.events.monitorRequests, [1]);
  // The helper confirms: the input helper now maps onto the second display (left of the primary).
  c.events.onMonitors({ ...TWO_SCREENS, current: 1 });
  await waitFor(() => c.events.input.at(-1) === 'r -1920 0 1920 1080', 'pointer mapped onto display 2');
  await waitFor(() => c.binary.length > base + 1, 'second monitors message');
  const confirmed = (await c.receive()).filter((m) => m.t === 'monitors');
  assert.equal(confirmed.at(-1).current, 1);
});

test('displays: unknown, repeated or malformed choices never reach the helper', async () => {
  const c = await connect({ config: { id: ID }, mode: 'control', codecs: ['h264'] });
  await c.input({ t: 'mon', i: 1 }); // nothing reported yet
  c.events.onMonitors(TWO_SCREENS);
  await c.input({ t: 'mon', i: 2 });
  await c.input({ t: 'mon', i: -1 });
  await c.input({ t: 'mon', i: 0 }); // already shown
  await c.input({ t: 'mon', i: 1.5 });
  await c.input({ t: 'mon', i: '1' });
  await c.input({ t: 'mon' });
  assert.deepEqual(c.events.monitorRequests, []);
  await c.input({ t: 'mon', i: 1 });
  assert.deepEqual(c.events.monitorRequests, [1]);
});

test('displays: a view-only viewer may switch display but still gets no input injector', async () => {
  const c = await connect({ config: { id: ID }, mode: 'view', codecs: ['h264'] });
  c.events.onMonitors(TWO_SCREENS);
  await c.input({ t: 'mon', i: 1 });
  assert.deepEqual(c.events.monitorRequests, [1]);
  assert.deepEqual(c.events.input, []);
});

test('displays: the choice survives the fallback to JPEG', async () => {
  const c = await connect({ config: { id: ID }, mode: 'control', codecs: ['h264', 'jpeg'] });
  c.events.onMonitors(TWO_SCREENS);
  await c.input({ t: 'mon', i: 1 });
  c.events.onMonitors({ ...TWO_SCREENS, current: 1 });
  await c.input({ t: 'codec', codec: 'jpeg' });
  assert.equal(c.events.captureOptions.codec, 'jpeg');
  assert.equal(c.events.captureOptions.monitor, 1, 'the new helper starts on the display being viewed');
});

test('displays: a replaced helper cannot move the pointer mapping', async () => {
  const c = await connect({ config: { id: ID }, mode: 'control', codecs: ['h264', 'jpeg'] });
  const old = c.events.captureOptions;
  await c.input({ t: 'codec', codec: 'jpeg' });
  const before = c.events.input.length;
  old.onMonitors(TWO_SCREENS);
  assert.equal(c.events.input.length, before);
});

test('a viewer keyframe request is forwarded, even in view-only mode', async () => {
  const c = await connect({ config: { id: ID }, mode: 'view', codecs: ['h264'] });
  const before = c.events.keyRequests;
  await c.input({ t: 'key' });
  assert.equal(c.events.keyRequests, before + 1);
});

test('stopping from the indicator sends an encrypted bye then leaves', async () => {
  const c = await connect({ config: { id: ID } });
  await c.receive();
  c.events.indicator.onStop();
  await waitFor(() => c.sent.at(-1)?.t === 'leave', 'leave after the encrypted bye');
  assert.equal(c.events.ended, 'stopped-by-host');
  assert.deepEqual(await c.receive(), [{ t: 'bye', reason: 'stopped-by-host' }]);
  assert.deepEqual(c.sent.at(-1), { t: 'leave' });
});

test('a tampered input packet ends the session and is not executed', async () => {
  const c = await connect({ config: { id: ID } });
  const packet = await c.viewer.channel.sealJson({ t: 'tx', ch: 'a' });
  const bad = Uint8Array.from(packet);
  bad[bad.length - 2] ^= 0x40;
  await c.session.onBinary(bad);
  assert.deepEqual(c.events.input, []);
  assert.equal(c.events.ended, 'crypto-error');
  assert.deepEqual(c.sent.at(-1), { t: 'leave' });
});

test('a replayed input packet ends the session', async () => {
  const c = await connect({ config: { id: ID } });
  const packet = await c.viewer.channel.sealJson({ t: 'tx', ch: 'a' });
  await c.session.onBinary(packet);
  await c.session.onBinary(packet);
  assert.deepEqual(c.events.input, ['u 97']);
  assert.equal(c.events.ended, 'crypto-error');
});

test('plaintext input injected by the relay is ignored', async () => {
  const c = await connect({ config: { id: ID } });
  await c.session.onMessage({ t: 'mv', x: 0.5, y: 0.5 });
  await c.session.onMessage({ t: 'tx', ch: 'rm -rf' });
  await c.session.onMessage({ t: 'accepted', mode: 'control' });
  assert.deepEqual(c.events.input, []);
});

test('a viewer key that does not match its commitment is refused', async () => {
  const h = harness({ config: { id: ID } });
  h.session.begin();
  const viewer = new ViewerE2E({ id: ID });
  const commit = await viewer.commitMessage();
  await h.session.onMessage(commit);
  const key = h.sent.find((m) => m.t === 'hello-key');
  const auth = await viewer.authMessage({ challenge: h.sent[0], hpub: key.hpub, mode: 'control', label: 'x' });
  const swapped = await newEphemeral(); // relay substitutes its own key after the commitment
  await h.session.onMessage({ ...auth, vpub: toB64(swapped.pub) });
  assert.deepEqual(h.sent.find((m) => m.t === 'denied'), { t: 'denied', reason: 'bad_request' });
  assert.equal(await commitmentOf(swapped.pub) === commit.c, false);
  assert.equal(h.events.captureStarted, 0);
});

test('handshake messages out of order are ignored', async () => {
  const h = harness({ config: { id: ID } });
  h.session.begin();
  await h.session.onMessage({ t: 'auth', vpub: 'AAAA', d: 'AAAA', pw: false });
  assert.equal(h.sent.some((m) => m.t === 'denied' || m.t === 'hello-key'), false);
});

test('viewer labels cannot smuggle control or bidi characters', () => {
  assert.equal(sanitizeLabel('Bob\u202Eevil\n\r\u0000'), 'Bobevil');
  assert.equal(sanitizeLabel('   '), 'inconnu');
  assert.equal(sanitizeLabel('x'.repeat(100)).length, 40);
});

test('keymap: physical keys map to scancodes, unknown codes do not', () => {
  assert.deepEqual(lookupKey('KeyA'), [0x1e, 0]);
  assert.deepEqual(lookupKey('Enter'), [0x1c, 0]);
  assert.deepEqual(lookupKey('NumpadEnter'), [0x1c, 1]);
  assert.deepEqual(lookupKey('ArrowUp'), [0x48, 1]);
  assert.equal(lookupKey('__proto__'), null);
  assert.equal(lookupKey('constructor'), null);
  assert.equal(lookupKey(42), null);
});

test('capture frame parser reassembles frames split across chunks', () => {
  const frames = [];
  const parser = new FrameParser((w, h, jpeg) => frames.push([w, h, Buffer.from(jpeg)]));
  const body = Buffer.from([0xff, 0xd8, 9, 9, 9]);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.writeUInt16BE(1280, 4);
  head.writeUInt16BE(720, 6);
  const wire = Buffer.concat([head, body, head, body]);
  parser.push(wire.subarray(0, 3));
  parser.push(wire.subarray(3, 14));
  parser.push(wire.subarray(14));
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], [1280, 720, body]);
  assert.throws(() => new FrameParser(() => {}).push(Buffer.alloc(8)));
});

void KIND_JSON;

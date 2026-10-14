import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_ITERATIONS, deriveKey, randomB64 } from '../shared/auth.js';
import {
  KIND_FRAME,
  KIND_JSON,
  commitmentOf,
  deriveChannel,
  newEphemeral,
  packFrameBody,
  parseJsonBody,
  unpackFrameBody,
} from '../shared/e2e.js';

const ID = '123456789';

/** Honest handshake between a host and a viewer (no relay interference). */
async function handshake({ hostPassword, viewerPassword, id = ID, nonce = randomB64(16) } = {}) {
  const host = await newEphemeral();
  const viewer = await newEphemeral();
  const common = { hostPub: host.pub, viewerPub: viewer.pub, nonce, id };
  const h = await deriveChannel({ ...common, role: 'host', privateKey: host.privateKey, peerPub: viewer.pub, passwordKey: hostPassword });
  const v = await deriveChannel({ ...common, role: 'viewer', privateKey: viewer.privateKey, peerPub: host.pub, passwordKey: viewerPassword });
  return { h, v, host, viewer, nonce };
}

const json = (obj) => new TextEncoder().encode(JSON.stringify(obj));

test('both sides derive the same code and talk in both directions', async () => {
  const { h, v } = await handshake();
  assert.match(h.sas, /^\d{6}$/);
  assert.equal(h.sas, v.sas);

  const toHost = await v.channel.sealJson({ t: 'mv', x: 0.1, y: 0.2 });
  const got = await h.channel.open(toHost);
  assert.equal(got.kind, KIND_JSON);
  assert.deepEqual(parseJsonBody(got.body), { t: 'mv', x: 0.1, y: 0.2 });

  const frame = await h.channel.seal(KIND_FRAME, packFrameBody(1280, 720, Uint8Array.of(0xff, 0xd8, 7, 0xff, 0xd9)));
  const seen = await v.channel.open(frame);
  assert.equal(seen.kind, KIND_FRAME);
  const f = unpackFrameBody(seen.body);
  assert.equal(f.width, 1280);
  assert.equal(f.height, 720);
  assert.deepEqual([...f.jpeg], [0xff, 0xd8, 7, 0xff, 0xd9]);
});

test('ciphertext does not contain the plaintext', async () => {
  const { h } = await handshake();
  const secret = 'TOP-SECRET-SCREEN-CONTENT';
  const packet = await h.channel.seal(KIND_JSON, json({ secret }));
  assert.equal(Buffer.from(packet).includes(Buffer.from(secret)), false);
});

test('tampered packets are rejected', async () => {
  const { h, v } = await handshake();
  const packet = await v.channel.sealJson({ t: 'kd', code: 'KeyA' });
  const bad = Uint8Array.from(packet);
  bad[bad.length - 1] ^= 1;
  await assert.rejects(h.channel.open(bad));
  const header = Uint8Array.from(packet);
  header[8] ^= 1; // counter
  await assert.rejects(h.channel.open(header));
});

test('replayed, dropped and reordered packets are rejected', async () => {
  const { h, v } = await handshake();
  const p0 = await v.channel.sealJson({ n: 0 });
  const p1 = await v.channel.sealJson({ n: 1 });
  const p2 = await v.channel.sealJson({ n: 2 });

  await assert.rejects(h.channel.open(p1), 'out of order');
  await h.channel.open(p0);
  await assert.rejects(h.channel.open(p0), 'replay');
  await h.channel.open(p1);
  await assert.rejects(h.channel.open(p0), 'old packet');
  await h.channel.open(p2);
});

test('a packet cannot be reflected back to its sender', async () => {
  const { h, v } = await handshake();
  const packet = await v.channel.sealJson({ t: 'x' });
  await assert.rejects(v.channel.open(packet)); // directional keys
  void h;
});

test('password mode: same password works, another one cannot decrypt', async () => {
  const salt = randomB64(16);
  const pw = await deriveKey('s3cret-pass', salt, MIN_ITERATIONS);
  const same = await handshake({ hostPassword: pw, viewerPassword: pw });
  const packet = await same.v.channel.sealJson({ ok: true });
  assert.deepEqual(parseJsonBody((await same.h.channel.open(packet)).body), { ok: true });

  const other = await deriveKey('another-pass', salt, MIN_ITERATIONS);
  const wrong = await handshake({ hostPassword: pw, viewerPassword: other });
  await assert.rejects(wrong.h.channel.open(await wrong.v.channel.sealJson({ ok: true })));

  const none = await handshake({ hostPassword: pw, viewerPassword: undefined });
  await assert.rejects(none.h.channel.open(await none.v.channel.sealJson({ ok: true })));
});

test('the channel is bound to the host ID and nonce', async () => {
  const host = await newEphemeral();
  const viewer = await newEphemeral();
  const nonce = randomB64(16);
  const base = { hostPub: host.pub, viewerPub: viewer.pub };
  const h = await deriveChannel({ ...base, role: 'host', privateKey: host.privateKey, peerPub: viewer.pub, nonce, id: ID });
  const viewerOtherId = await deriveChannel({ ...base, role: 'viewer', privateKey: viewer.privateKey, peerPub: host.pub, nonce, id: '999999999' });
  const viewerOtherNonce = await deriveChannel({ ...base, role: 'viewer', privateKey: viewer.privateKey, peerPub: host.pub, nonce: randomB64(16), id: ID });
  await assert.rejects(h.channel.open(await viewerOtherId.channel.sealJson({ a: 1 })));
  await assert.rejects(h.channel.open(await viewerOtherNonce.channel.sealJson({ a: 1 })));
});

test('a man in the middle gets two different codes and cannot read either leg', async () => {
  const nonce = randomB64(16);
  const host = await newEphemeral();
  const viewer = await newEphemeral();
  const mitmToViewer = await newEphemeral(); // pretends to be the host toward the viewer
  const mitmToHost = await newEphemeral(); // pretends to be the viewer toward the host

  const viewerSide = await deriveChannel({
    role: 'viewer', privateKey: viewer.privateKey, peerPub: mitmToViewer.pub,
    hostPub: mitmToViewer.pub, viewerPub: viewer.pub, nonce, id: ID,
  });
  const hostSide = await deriveChannel({
    role: 'host', privateKey: host.privateKey, peerPub: mitmToHost.pub,
    hostPub: host.pub, viewerPub: mitmToHost.pub, nonce, id: ID,
  });
  // The two people read different codes aloud -> mismatch -> the host refuses.
  // (A 1-in-a-million coincidence is possible per attempt; the commitment below stops grinding.)
  assert.notEqual(viewerSide.sas, hostSide.sas);
  await assert.rejects(hostSide.channel.open(await viewerSide.channel.sealJson({ x: 1 })));
});

test('commitments bind the viewer key before the host key is revealed', async () => {
  const a = await newEphemeral();
  const b = await newEphemeral();
  assert.equal(await commitmentOf(a.pub), await commitmentOf(a.pub));
  assert.notEqual(await commitmentOf(a.pub), await commitmentOf(b.pub));
});

test('malformed public keys are refused', async () => {
  const me = await newEphemeral();
  const base = { role: 'host', privateKey: me.privateKey, hostPub: me.pub, viewerPub: me.pub, nonce: randomB64(16), id: ID };
  await assert.rejects(deriveChannel({ ...base, peerPub: new Uint8Array(64) }));
  await assert.rejects(deriveChannel({ ...base, peerPub: new Uint8Array(65) }));
  const offCurve = new Uint8Array(65);
  offCurve[0] = 4;
  offCurve.fill(1, 1);
  await assert.rejects(deriveChannel({ ...base, peerPub: offCurve }));
});

test('short or foreign packets are rejected without throwing outside the promise', async () => {
  const { h } = await handshake();
  await assert.rejects(h.channel.open(new Uint8Array(5)));
  await assert.rejects(h.channel.open(new Uint8Array(40))); // wrong type byte
});

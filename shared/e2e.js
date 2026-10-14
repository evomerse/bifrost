// End-to-end encryption between a Bifrost host agent and a viewer. The relay server only
// sees ciphertext. Runs unchanged in Node (>=20) and in browsers (WebCrypto).
//
// Handshake (messages relayed by the server, none of them secret):
//   host   -> viewer  challenge {salt, iters, nonce, hasPassword}
//   viewer -> host    commit    {c = SHA256(viewerPub)}          viewer commits to its key first
//   host   -> viewer  hello-key {hpub}                           host ephemeral ECDH P-256 key
//   viewer -> host    auth      {vpub, pw, d}                    d = first encrypted message
//
// Both sides derive: Z = ECDH(own, peer); transcript = H(label, id, nonce, hpub, vpub);
// keys = HKDF(Z [|| passwordKey], salt = transcript). Separate AES-256-GCM keys per direction,
// strictly increasing 64-bit counters as nonces (a replayed, dropped or reordered packet
// fails). Authentication of the exchange:
//   - password mode: the password-derived key is mixed into the HKDF input, so a relay that
//     does not know the password cannot complete the handshake;
//   - consent mode: both sides display a 6-digit code (SAS) derived from the transcript.
//     Because the viewer commits to its key before seeing the host's, a man in the middle
//     cannot grind for matching codes: a substitution is caught when the people compare.
//
// Wire format after the handshake: [0x02][u64 BE counter][AES-GCM ciphertext+tag] where the
// plaintext is [kind][body], kind 1 = JPEG frame (u16 w, u16 h, JPEG), kind 2 = JSON,
// kind 3 = H.264 access unit (u8 flags[bit0 = keyframe], u16 w, u16 h, Annex B),
// kind 4 = file chunk (u32 transfer id, u8 flags[bit0 = last chunk], data).

import { deriveKey, fromB64, toB64 } from './auth.js';

const te = new TextEncoder();
const td = new TextDecoder();

export const WIRE_SECURE = 0x02;
export const KIND_FRAME = 1;
export const KIND_JSON = 2;
export const KIND_VIDEO = 3;
export const KIND_FILE = 4;

const LABEL = 'bifrost-e2e-v2';
const AAD = te.encode('bifrost/e2e/1');
const subtle = () => globalThis.crypto.subtle;

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function sha256(...parts) {
  return new Uint8Array(await subtle().digest('SHA-256', concat(...parts)));
}

/** Fresh ephemeral ECDH P-256 key pair; the private key is non-extractable. */
export async function newEphemeral() {
  const pair = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, pub };
}

export async function commitmentOf(pub) {
  return toB64(await sha256(te.encode('bifrost-commit'), pub));
}

async function aesKey(bytes) {
  return subtle().importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * Derives the directional channel and the verification code.
 * @param {'host'|'viewer'} role
 * @param {Uint8Array} [passwordKey] 32-byte PBKDF2 key, only in password mode
 */
export async function deriveChannel({ role, privateKey, peerPub, hostPub, viewerPub, nonce, id, passwordKey }) {
  if (!(peerPub instanceof Uint8Array) || peerPub.length !== 65 || peerPub[0] !== 0x04) {
    throw new Error('invalid public key');
  }
  const peer = await subtle().importKey('raw', peerPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const z = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: peer }, privateKey, 256));
  const transcript = await sha256(te.encode(LABEL), te.encode(id), fromB64(nonce), hostPub, viewerPub);
  const ikm = passwordKey ? concat(z, passwordKey) : z;
  const hkdf = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const expand = async (info) =>
    new Uint8Array(
      await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: transcript, info: te.encode(info) }, hkdf, 256),
    );
  const [c2h, h2c, sasBytes] = await Promise.all([expand('c2h'), expand('h2c'), expand('sas')]);
  const sas = String(new DataView(sasBytes.buffer).getUint32(0) % 1_000_000).padStart(6, '0');
  const [sendKey, recvKey] = role === 'host' ? [h2c, c2h] : [c2h, h2c];
  return { channel: new SecureChannel(await aesKey(sendKey), await aesKey(recvKey)), sas };
}

export class SecureChannel {
  #sendKey;
  #recvKey;
  #sendCtr = 0n;
  #recvCtr = 0n;
  #sendQ = Promise.resolve();
  #recvQ = Promise.resolve();

  constructor(sendKey, recvKey) {
    this.#sendKey = sendKey;
    this.#recvKey = recvKey;
  }

  /** Encrypts [kind][body] into a wire packet. Calls are serialized: output order = call order. */
  seal(kind, body) {
    const run = async () => {
      const ctr = this.#sendCtr++;
      const iv = new Uint8Array(12);
      new DataView(iv.buffer).setBigUint64(4, ctr);
      const ct = new Uint8Array(
        await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, this.#sendKey, concat(Uint8Array.of(kind), body)),
      );
      const out = new Uint8Array(9 + ct.length);
      out[0] = WIRE_SECURE;
      new DataView(out.buffer).setBigUint64(1, ctr);
      out.set(ct, 9);
      return out;
    };
    const p = this.#sendQ.then(run);
    this.#sendQ = p.catch(() => {});
    return p;
  }

  sealJson(obj) {
    return this.seal(KIND_JSON, te.encode(JSON.stringify(obj)));
  }

  /** Decrypts a wire packet. Rejects on tampering, replay, reordering or a missing packet. */
  open(wire) {
    const run = async () => {
      if (!(wire instanceof Uint8Array) || wire.length < 26 || wire[0] !== WIRE_SECURE) throw new Error('bad packet');
      const ctr = new DataView(wire.buffer, wire.byteOffset, wire.byteLength).getBigUint64(1);
      if (ctr !== this.#recvCtr) throw new Error('unexpected counter');
      const iv = new Uint8Array(12);
      new DataView(iv.buffer).setBigUint64(4, ctr);
      const plain = new Uint8Array(
        await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: AAD }, this.#recvKey, wire.subarray(9)),
      );
      this.#recvCtr++;
      return { kind: plain[0], body: plain.subarray(1) };
    };
    const p = this.#recvQ.then(run);
    this.#recvQ = p.catch(() => {});
    return p;
  }
}

export function parseJsonBody(body) {
  const msg = JSON.parse(td.decode(body));
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('bad json');
  return msg;
}

export function packFrameBody(width, height, jpeg) {
  const head = new Uint8Array(4);
  const dv = new DataView(head.buffer);
  dv.setUint16(0, width);
  dv.setUint16(2, height);
  return concat(head, jpeg);
}

export function unpackFrameBody(body) {
  if (body.length < 5) throw new Error('short frame');
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  return { width: dv.getUint16(0), height: dv.getUint16(2), jpeg: body.subarray(4) };
}

export function packVideoBody(key, width, height, annexB) {
  const head = new Uint8Array(5);
  const dv = new DataView(head.buffer);
  head[0] = key ? 1 : 0;
  dv.setUint16(1, width);
  dv.setUint16(3, height);
  return concat(head, annexB);
}

export function unpackVideoBody(body) {
  if (body.length < 6) throw new Error('short video packet');
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  return { key: (body[0] & 1) === 1, width: dv.getUint16(1), height: dv.getUint16(3), data: body.subarray(5) };
}

export function packFileBody(id, last, data) {
  const head = new Uint8Array(5);
  new DataView(head.buffer).setUint32(0, id);
  head[4] = last ? 1 : 0;
  return concat(head, data);
}

export function unpackFileBody(body) {
  if (body.length < 5) throw new Error('short file chunk');
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  return { id: dv.getUint32(0), last: (body[4] & 1) === 1, data: body.subarray(5) };
}

/**
 * WebCodecs codec string ("avc1.PPCCLL") from the SPS found in an Annex B buffer, or null.
 * profile_idc, constraint flags and level_idc are the three bytes after the NAL header.
 */
export function codecStringFromAnnexB(data) {
  for (let i = 0; i + 6 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 0x1f) === 7) {
      const hex = (n) => n.toString(16).padStart(2, '0');
      return `avc1.${hex(data[i + 4])}${hex(data[i + 5])}${hex(data[i + 6])}`;
    }
  }
  return null;
}

/** Viewer side of the handshake, shared by the browser page and the tests. */
export class ViewerE2E {
  constructor({ id, password = '' }) {
    this.id = id;
    this.password = password;
    this.channel = null;
    this.sas = null;
    this.usedPassword = false;
  }

  async commitMessage() {
    this.keys = await newEphemeral();
    return { t: 'commit', c: await commitmentOf(this.keys.pub) };
  }

  /** @param challenge the host's challenge message, @param hpub base64 host key */
  async authMessage({ challenge, hpub, mode, label, codecs = ['jpeg'] }) {
    this.usedPassword = Boolean(this.password) && challenge.hasPassword === true;
    const passwordKey = this.usedPassword ? await deriveKey(this.password, challenge.salt, challenge.iters) : undefined;
    const hostPub = fromB64(hpub);
    const { channel, sas } = await deriveChannel({
      role: 'viewer',
      privateKey: this.keys.privateKey,
      peerPub: hostPub,
      hostPub,
      viewerPub: this.keys.pub,
      nonce: challenge.nonce,
      id: this.id,
      passwordKey,
    });
    this.channel = channel;
    this.sas = sas;
    const d = toB64(await channel.sealJson({ mode, label, codecs }));
    return { t: 'auth', vpub: toB64(this.keys.pub), pw: this.usedPassword, d };
  }
}


import os from 'node:os';
import { fromB64, randomB64, toB64, PBKDF2_ITERATIONS } from '../shared/auth.js';
import {
  KIND_FILE,
  KIND_FRAME,
  KIND_JSON,
  KIND_VIDEO,
  commitmentOf,
  deriveChannel,
  newEphemeral,
  packFileBody,
  packFrameBody,
  packVideoBody,
  parseJsonBody,
  unpackFileBody,
} from '../shared/e2e.js';
import { FileService } from './files.js';
import { lookupKey } from './keymap.js';

const MAX_CLIPBOARD_CHARS = 512 * 1024;
const MAX_BACKLOG = 1.5 * 1024 * 1024;
const TARGET_BITRATE = 4_000_000;
const MIN_BITRATE = 600_000;
const KEYFRAME_MIN_INTERVAL_MS = 500;
const ADAPT_INTERVAL_MS = 4000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 5 * 60_000;

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

export function sanitizeLabel(value) {
  const s = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim()
    .slice(0, 40);
  return s || 'inconnu';
}

/** Failed password attempts are counted per agent: the relay hides the real origin. */
export class PasswordGuard {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.failures = 0;
    this.lockedUntil = 0;
  }
  get locked() {
    return this.now() < this.lockedUntil;
  }
  fail() {
    this.failures += 1;
    if (this.failures >= MAX_FAILURES) {
      this.lockedUntil = this.now() + LOCKOUT_MS;
      this.failures = 0;
    }
  }
  ok() {
    this.failures = 0;
  }
}

/**
 * One remote session, from pairing to teardown.
 *
 *   challenge -> commit -> hello-key -> auth (first encrypted message)
 *             -> [consent dialog showing the verification code] -> accepted | denied
 *             -> encrypted frames + encrypted input
 *
 * `helpers` supplies the OS side (capture, input, indicator, consent dialog) so the
 * logic can be tested without a screen. Everything after `auth` is end-to-end encrypted.
 */
export class Session {
  /**
   * `permissions` is what the owner of this PC allows a remote person to do, besides seeing
   * and controlling the screen: { clipboard: boolean, fileTransfer: 'ask'|'allow'|'deny',
   * roots: [{ name, dir, read, write }] }. Everything is off unless stated.
   */
  constructor({
    send, sendBinary, bufferedAmount, peerIp, config, helpers, guard, log = () => {}, onEnd,
    permissions = { clipboard: false, fileTransfer: 'deny', roots: [] },
    adaptIntervalMs = ADAPT_INTERVAL_MS, keyframeMinIntervalMs = KEYFRAME_MIN_INTERVAL_MS,
  }) {
    this.permissions = permissions;
    this.send = send;
    this.sendBinary = sendBinary;
    this.bufferedAmount = bufferedAmount ?? (() => 0);
    this.peerIp = peerIp ?? 'inconnue';
    this.config = config;
    this.helpers = helpers;
    this.guard = guard;
    this.log = log;
    this.onEnd = onEnd;
    this.adaptIntervalMs = adaptIntervalMs;
    this.keyframeMinIntervalMs = keyframeMinIntervalMs;
    this.state = 'challenge';
    this.mode = 'view';
    this.nonce = randomB64(16);
    this.parts = {};
    this.channel = null;
    this.lastFrame = null;
    this.ended = false;
    this.codecs = ['jpeg'];
    this.bitrate = TARGET_BITRATE;
    this.waitingKey = true; // an H.264 viewer can only start from a keyframe
    this.monitor = 0; // index of the captured display (0 = primary)
    this.monitorList = null; // as reported by the capture helper, null until it did
    this.lastKeyRequest = 0;
    this.congested = false;
  }

  begin() {
    this.send({
      t: 'challenge',
      v: 2,
      host: os.hostname(),
      hasPassword: Boolean(this.config.passwordKey),
      salt: this.config.passwordSalt ?? randomB64(16),
      iters: this.config.passwordIters ?? PBKDF2_ITERATIONS,
      nonce: this.nonce,
    });
  }

  /** Plaintext handshake messages relayed by the server. */
  async onMessage(msg) {
    if (this.ended || !msg || typeof msg.t !== 'string') return;
    if (this.state === 'challenge' && msg.t === 'commit' && typeof msg.c === 'string') {
      this.commit = msg.c;
      this.hostKeys = await newEphemeral();
      this.state = 'keyed';
      this.send({ t: 'hello-key', hpub: toB64(this.hostKeys.pub) });
    } else if (this.state === 'keyed' && msg.t === 'auth') {
      this.state = 'auth';
      await this.#authenticate(msg);
    }
  }

  /** Encrypted traffic (input events) from the viewer. */
  async onBinary(wire) {
    if (this.ended || this.state !== 'active' || !this.channel) return;
    try {
      const { kind, body } = await this.channel.open(new Uint8Array(wire));
      if (kind === KIND_FILE) {
        const chunk = unpackFileBody(body);
        this.parts.files?.onChunk(chunk.id, chunk.last, chunk.data);
        return;
      }
      if (kind !== KIND_JSON) throw new Error('unexpected kind');
      this.#input(parseJsonBody(body));
    } catch (err) {
      this.log(`flux chiffré invalide, session coupée : ${err.message}`);
      this.end('crypto-error', { leave: true });
    }
  }

  async #authenticate(msg) {
    if (typeof msg.vpub !== 'string' || typeof msg.d !== 'string') return this.#deny('bad_request');
    let viewerPub;
    let wire;
    try {
      viewerPub = fromB64(msg.vpub);
      wire = fromB64(msg.d);
    } catch {
      return this.#deny('bad_request');
    }
    // The viewer committed to its key before it saw ours: anything else is tampering.
    if ((await commitmentOf(viewerPub)) !== this.commit) return this.#deny('bad_request');

    const usePassword = msg.pw === true;
    if (usePassword) {
      if (!this.config.passwordKey) return this.#deny('no_password');
      if (this.guard.locked) return this.#deny('locked');
    }

    let hello;
    try {
      const { channel, sas } = await deriveChannel({
        role: 'host',
        privateKey: this.hostKeys.privateKey,
        peerPub: viewerPub,
        hostPub: this.hostKeys.pub,
        viewerPub,
        nonce: this.nonce,
        id: this.config.id,
        passwordKey: usePassword ? fromB64(this.config.passwordKey) : undefined,
      });
      // Opening the first message proves the viewer derived the same keys, hence knows the
      // password in password mode. A wrong password simply fails to decrypt.
      const { kind, body } = await channel.open(wire);
      if (kind !== KIND_JSON) throw new Error('unexpected kind');
      hello = parseJsonBody(body);
      this.channel = channel;
      this.sas = sas;
    } catch {
      if (usePassword) {
        this.guard.fail();
        this.log(`mot de passe incorrect depuis ${this.peerIp}`);
        return this.#deny('bad_password');
      }
      return this.#deny('bad_request');
    }

    this.mode = hello.mode === 'control' ? 'control' : 'view';
    const label = sanitizeLabel(hello.label);
    const offered = Array.isArray(hello.codecs) ? hello.codecs : [];
    this.codecs = ['h264', 'jpeg'].filter((c) => offered.includes(c));
    if (this.codecs.length === 0) this.codecs = ['jpeg'];

    if (usePassword) {
      this.guard.ok();
      if (!this.config.requireConsent) return this.#grant(label, 'password');
    }
    await this.#askConsent(label);
  }

  async #askConsent(label) {
    await this.#secure({ t: 'waiting-consent' });
    const what = this.mode === 'control' ? 'prendre le contrôle de' : 'voir l’écran de';
    const code = `${this.sas.slice(0, 3)} ${this.sas.slice(3)}`;
    const dialog = this.helpers.askConsent({
      title: 'Bifrost - Demande de connexion',
      text:
        `Une personne demande à ${what} cet ordinateur.\n\n` +
        `Adresse : ${this.peerIp}\n` +
        `Nom indiqué (non vérifié) : ${label}\n\n` +
        `Code de vérification : ${code}\n` +
        'Ne l’acceptez que si la personne en face voit exactement le même code.\n\n' +
        'Autoriser ?',
    });
    this.parts.consent = dialog;
    const yes = await dialog.promise;
    this.parts.consent = null;
    if (this.ended) return;
    if (yes) await this.#grant(label, 'consent');
    else await this.#deny('refused');
  }

  async #deny(reason) {
    if (this.channel) await this.#secure({ t: 'denied', reason });
    else this.send({ t: 'denied', reason });
    this.end('denied', { leave: true });
  }

  async #grant(label, how) {
    this.state = 'active';
    this.log(`session acceptée (${how}) : ${this.mode}, ${this.peerIp}, "${label}"`);
    await this.#secure({ t: 'accepted', mode: this.mode });
    if (this.ended) return;

    this.parts.indicator = this.helpers.showIndicator({
      text: `Bifrost - Votre écran est partagé (${this.peerIp})`,
      stopLabel: 'Arrêter',
      onStop: () => this.end('stopped-by-host', { notifyPeer: true, leave: true }),
    });
    if (this.mode === 'control') this.parts.input = this.helpers.startInput();
    this.#startExtras();
    this.#startCapture(this.codecs.includes('h264') ? 'h264' : 'jpeg');
    const timer = setInterval(() => this.#adapt(), this.adaptIntervalMs);
    timer.unref?.();
    this.parts.adapt = { stop: () => clearInterval(timer) };
  }

  /**
   * Starts (or restarts) the capture helper. A replaced helper is detached first, so that its
   * late frames and its exit do not affect the session.
   */
  #startCapture(codec) {
    const previous = this.parts.capture;
    this.parts.capture = null;
    previous?.stop?.();
    this.waitingKey = true;
    this.lastFrame = null;
    const handle = this.helpers.startCapture({
      codec,
      bitrate: this.bitrate,
      monitor: this.monitor,
      onFrame: (frame) => {
        if (this.parts.capture === handle) this.#frame(frame);
      },
      onMonitors: (report) => {
        if (this.parts.capture === handle) this.#monitors(report);
      },
      onExit: () => {
        if (this.parts.capture === handle) this.end('capture-stopped', { notifyPeer: true, leave: true });
      },
    });
    this.parts.capture = handle;
  }

  /**
   * The capture helper reported the displays (at start, then on every change). The viewer gets
   * sizes only; the pointer is mapped onto the captured display by the input helper.
   */
  #monitors({ current, list }) {
    if (this.ended || !this.channel) return;
    this.monitorList = list;
    this.monitor = current;
    const shown = list[current];
    this.parts.input?.send(`r ${shown.x} ${shown.y} ${shown.w} ${shown.h}`);
    this.#secure({
      t: 'monitors',
      current,
      list: list.map((m) => ({ w: m.w, h: m.h, primary: m.primary })),
    });
  }

  /** The viewer's browser cannot decode our H.264: continue with JPEG. */
  #switchToJpeg() {
    if (this.ended || !this.codecs.includes('h264')) return;
    this.log('la visionneuse ne décode pas le H.264 : bascule en JPEG');
    this.codecs = ['jpeg'];
    this.#startCapture('jpeg');
  }

  /**
   * Clipboard and file transfer. Only in control mode: a view-only session must not be able
   * to read the clipboard or fetch files. The viewer is told what is available.
   */
  #startExtras() {
    const p = this.permissions;
    const control = this.mode === 'control';
    const clipboard = control && Boolean(p.clipboard) && typeof this.helpers.startClipboard === 'function';
    const fileTransfer = control && p.fileTransfer !== 'deny' && p.roots.length > 0 ? p.fileTransfer : 'deny';

    if (clipboard) {
      this.parts.clipboard = this.helpers.startClipboard({
        onSet: (ok) => this.#secure({ t: 'clip-set', ok }),
        onChange: (text) => {
          if (typeof text === 'string' && text.length <= MAX_CLIPBOARD_CHARS) this.#secure({ t: 'clip', text });
        },
      });
    }
    if (fileTransfer !== 'deny') {
      p.ensureDirs?.();
      this.parts.files = new FileService({
        roots: p.roots,
        policy: fileTransfer,
        ask: ({ title, text }) => this.helpers.askConsent({ title, text }).promise,
        send: (m) => this.#secure(m),
        sendChunk: (id, last, data) => this.#emit(KIND_FILE, packFileBody(id, last, data)),
        bufferedAmount: () => this.bufferedAmount(),
        log: this.log,
        maxFileBytes: p.maxFileBytes,
      });
      this.parts.files.stop = () => this.parts.files.dispose();
    }
    this.#secure({
      t: 'perm',
      clipboard,
      files: fileTransfer,
      roots: fileTransfer === 'deny' ? [] : p.roots.map((r) => ({ name: r.name, read: r.read, write: r.write })),
    });
  }

  #requestKeyframe() {
    const now = Date.now();
    if (now - this.lastKeyRequest < this.keyframeMinIntervalMs) return;
    this.lastKeyRequest = now;
    this.parts.capture?.requestKeyframe?.();
  }

  /** Lowers the bitrate right after congestion, creeps back up while the link keeps up. */
  #adapt() {
    if (this.ended || !this.parts.capture?.setBitrate) return;
    let next = this.bitrate;
    if (this.congested) next = Math.max(MIN_BITRATE, Math.round(this.bitrate * 0.7));
    else if (this.bitrate < TARGET_BITRATE) next = Math.min(TARGET_BITRATE, Math.round(this.bitrate * 1.15));
    this.congested = false;
    if (next !== this.bitrate) {
      this.bitrate = next;
      this.parts.capture.setBitrate(next);
      this.log(`débit vidéo ajusté : ${Math.round(next / 1000)} kb/s`);
    }
  }

  async #secure(obj) {
    if (!this.channel || this.ended) return;
    const packet = await this.channel.sealJson(obj);
    if (!this.ended) this.sendBinary(packet);
  }

  #frame(frame) {
    if (this.ended || !this.channel) return;
    const { kind, key, width, height, data } = frame;
    const backlogged = this.bufferedAmount() > MAX_BACKLOG;

    if (kind === 'jpeg') {
      if (this.lastFrame && this.lastFrame.equals(data)) return; // unchanged screen
      this.lastFrame = Buffer.from(data);
      if (backlogged) return; // slow link: drop before encrypting, keeps counters contiguous
      this.#emit(KIND_FRAME, packFrameBody(width, height, data));
      return;
    }

    // H.264: every frame depends on the previous ones. After dropping one, nothing may be
    // sent until the next keyframe, otherwise the viewer would decode garbage.
    if (this.waitingKey) {
      if (!key) {
        this.#requestKeyframe();
        return;
      }
      if (backlogged) return;
      this.waitingKey = false;
    }
    if (backlogged) {
      this.waitingKey = true;
      this.congested = true;
      this.#requestKeyframe();
      return;
    }
    this.#emit(KIND_VIDEO, packVideoBody(key, width, height, data));
  }

  #emit(kind, body) {
    this.channel
      .seal(kind, body)
      .then((packet) => !this.ended && this.sendBinary(packet))
      .catch(() => {});
  }
  #input(msg) {
    if (msg.t === 'key') {
      this.#requestKeyframe(); // the viewer's decoder lost sync
      return;
    }
    if (msg.t === 'codec') {
      if (msg.codec === 'jpeg') this.#switchToJpeg();
      return;
    }
    if (msg.t === 'mon') {
      // Which display to look at: also allowed in view-only mode, it shows nothing the
      // person who accepted the connection did not already agree to share ("cet ordinateur").
      const list = this.monitorList;
      if (list && Number.isInteger(msg.i) && msg.i >= 0 && msg.i < list.length && msg.i !== this.monitor) {
        this.waitingKey = true; // the stream restarts at a keyframe of the new display
        this.parts.capture?.setMonitor?.(msg.i);
      }
      return;
    }
    if (msg.t === 'clip') {
      const clipboard = this.parts.clipboard;
      if (clipboard && this.mode === 'control' && typeof msg.text === 'string' && msg.text.length <= MAX_CLIPBOARD_CHARS) {
        clipboard.set(msg.text);
      }
      return;
    }
    if (msg.t.startsWith('fs-')) {
      this.parts.files?.handle(msg);
      return;
    }
    const input = this.parts.input;
    if (this.mode !== 'control' || !input || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'mv':
        if (isNum(msg.x) && isNum(msg.y)) input.send(`m ${clamp01(msg.x).toFixed(5)} ${clamp01(msg.y).toFixed(5)}`);
        break;
      case 'md':
      case 'mu': {
        if (!['l', 'r', 'm'].includes(msg.b)) break;
        if (isNum(msg.x) && isNum(msg.y)) input.send(`m ${clamp01(msg.x).toFixed(5)} ${clamp01(msg.y).toFixed(5)}`);
        input.send(`b ${msg.b} ${msg.t === 'md' ? 'd' : 'u'}`);
        break;
      }
      case 'wh': {
        const lim = (n) => Math.max(-1200, Math.min(1200, Math.trunc(n)));
        if (isNum(msg.dy) && lim(msg.dy) !== 0) input.send(`w ${lim(msg.dy)}`);
        if (isNum(msg.dx) && lim(msg.dx) !== 0) input.send(`h ${lim(msg.dx)}`);
        break;
      }
      case 'kd':
      case 'ku': {
        const key = lookupKey(msg.code);
        if (key) input.send(`k ${key[0]} ${key[1]} ${msg.t === 'kd' ? 'd' : 'u'}`);
        break;
      }
      case 'tx': {
        if (typeof msg.ch !== 'string' || msg.ch.length === 0 || msg.ch.length > 4) break;
        for (let i = 0; i < msg.ch.length; i++) input.send(`u ${msg.ch.charCodeAt(i)}`);
        break;
      }
      default:
    }
  }

  /** Idempotent teardown. The farewell is encrypted so a relay cannot forge or hide it. */
  end(reason, { notifyPeer = false, leave = false } = {}) {
    if (this.ended) return;
    const channel = this.channel;
    this.ended = true;
    this.state = 'ended';
    for (const part of Object.values(this.parts)) {
      try {
        if (part) (part.stop ?? part.cancel)?.call(part);
      } catch {
        /* helper already gone */
      }
    }
    this.log(`session terminée : ${reason}`);
    this.onEnd?.(reason);

    const sendLeave = () => {
      if (leave) this.send({ t: 'leave' });
    };
    if (notifyPeer && channel) {
      channel
        .sealJson({ t: 'bye', reason })
        .then((packet) => this.sendBinary(packet))
        .catch(() => {})
        .then(sendLeave);
    } else {
      sendLeave();
    }
  }
}

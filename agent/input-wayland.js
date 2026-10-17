// Input injection for Wayland sessions (GNOME, KDE Plasma...): the XDG desktop portal
// "RemoteDesktop" (org.freedesktop.portal.RemoteDesktop), spoken over the session D-Bus.
// A plain program cannot synthesize input on Wayland (xdotool only reaches XWayland windows); the
// portal is the sanctioned way: the person at the machine approves once in a system dialog, and
// the grant is remembered (restore token) so the next sessions start without the dialog.
//
// Same backend contract as XdotoolBackend in input-portable.js, plus moveNormalized(): the portal
// wants a position inside one of its streams (the monitors shared in the dialog), not global pixels.
import fs from 'node:fs';
import path from 'node:path';
import { PortableInput, XdotoolBackend, lookupScan } from './input-portable.js';

const PORTAL = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const RD = 'org.freedesktop.portal.RemoteDesktop';
const SC = 'org.freedesktop.portal.ScreenCast';
const SESSION = 'org.freedesktop.portal.Session';

const DEVICE_KEYBOARD_POINTER = 3; // 1 keyboard | 2 pointer
const SOURCE_MONITOR = 1;
const PERSIST_UNTIL_REVOKED = 2;
const START_TIMEOUT_MS = 180_000; // somebody has to click "Share" on the machine
const QUEUE_LIMIT = 400;

const BTN = { l: 0x110, r: 0x111, m: 0x112 }; // BTN_LEFT / BTN_RIGHT / BTN_MIDDLE
const KEYSYM = { '\n': 0xff0d, '\r': 0xff0d, '\t': 0xff09 };

// Windows set-1 scancodes and Linux evdev key codes are the same numbers for the plain keys;
// only the extended (E0) ones differ.
const EVDEV_EXT = {
  0x1c: 96, 0x1d: 97, 0x35: 98, 0x38: 100, 0x47: 102, 0x48: 103, 0x49: 104, 0x4b: 105, 0x4d: 106,
  0x4f: 107, 0x50: 108, 0x51: 109, 0x52: 110, 0x53: 111, 0x5b: 125, 0x5c: 126, 0x5d: 127,
};

/** Windows scancode (+ extended flag) -> evdev key code, or null for a key we do not map. */
export function evdevCode(scan, ext) {
  if (!lookupScan(scan, ext)) return null;
  return ext ? (EVDEV_EXT[scan] ?? null) : scan;
}

/** X11 keysym for one typed character (the portal accepts the 0x01000000 + code point form). */
export function keysymFor(ch) {
  const cp = ch.codePointAt(0);
  if (KEYSYM[ch]) return KEYSYM[ch];
  return cp >= 0x20 && cp <= 0x7e ? cp : 0x01000000 + cp;
}

/**
 * Which portal stream a Bifrost display (global rect, physical pixels) corresponds to. Streams
 * carry their position and size in the compositor's logical coordinates, so the display's scale
 * is rect.w / stream.w. With a single stream there is nothing to choose.
 */
export function pickStream(streams, rect) {
  if (!streams.length) return null;
  if (streams.length === 1 || !rect) return streams[0];
  let best = streams[0];
  let bestScore = Infinity;
  for (const s of streams) {
    const scale = rect.w / s.w;
    const score = Math.abs(rect.x - s.x * scale) + Math.abs(rect.y - s.y * scale) + Math.abs(scale - rect.h / s.h) * 1000;
    if (score < bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

const unwrap = (v) => (v && typeof v === 'object' && 'value' in v && 'signature' in v ? v.value : v);

/** Streams from the Start response: [[node_id, {position, size, ...}], ...]. */
export function parseStreams(raw) {
  const list = unwrap(raw) ?? [];
  return list
    .map(([node, props]) => {
      const [x, y] = unwrap(props?.position) ?? [0, 0];
      const [w, h] = unwrap(props?.size) ?? [0, 0];
      return { node: Number(node), x: Number(x), y: Number(y), w: Number(w), h: Number(h) };
    })
    .filter((s) => Number.isFinite(s.node));
}

/** Persists the portal's restore token in a small JSON file. */
export function fileTokenStore(file) {
  return {
    get() {
      try {
        const t = JSON.parse(fs.readFileSync(file, 'utf8')).token;
        return typeof t === 'string' && t ? t : null;
      } catch {
        return null;
      }
    },
    set(token) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ token }), { mode: 0o600 });
      } catch {
        /* the grant just will not be remembered */
      }
    },
  };
}

/**
 * @param {object}   o
 * @param {function} o.connect      async () => { bus, Message, Variant } (default: dbus-next on the session bus)
 * @param {object}   [o.tokenStore] { get(), set(token) }
 * @param {function} [o.onFail]     called once with an Error when the portal cannot be used
 */
export class PortalBackend {
  constructor({ connect = defaultConnect, tokenStore = null, log = () => {}, onFail = () => {} } = {}) {
    this.connectFn = connect;
    this.tokenStore = tokenStore;
    this.log = log;
    this.onFail = onFail;
    this.queue = [];
    this.ready = false;
    this.failed = false;
    this.stopped = false;
    this.streams = [];
    this.session = null;
    this.counter = 0;
    this.pending = new Map(); // request path -> { resolve, timer }
    this.#start().catch((err) => this.#fail(err));
  }

  // --- portal handshake -------------------------------------------------------------------

  #token() {
    return `bifrost${process.pid}_${++this.counter}`;
  }

  async #start() {
    const { bus, Message, Variant } = await this.connectFn();
    this.bus = bus;
    this.Message = Message;
    this.Variant = Variant;
    bus.on('message', (msg) => this.#onMessage(msg));
    bus.on?.('error', (err) => this.#fail(err));
    await this.#call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'AddMatch', 's', [
      "type='signal',interface='org.freedesktop.portal.Request',member='Response'",
    ]);

    const v = (sig, value) => new Variant(sig, value);
    const created = await this.#request(RD, 'CreateSession', 'a{sv}', (handle) => [
      { handle_token: v('s', handle), session_handle_token: v('s', this.#token()) },
    ]);
    const session = unwrap(created.session_handle);
    if (typeof session !== 'string') throw new Error('le portail n’a pas renvoyé de session');
    this.session = session;

    const restore = this.tokenStore?.get();
    await this.#request(RD, 'SelectDevices', 'oa{sv}', (handle) => [
      session,
      {
        handle_token: v('s', handle),
        types: v('u', DEVICE_KEYBOARD_POINTER),
        persist_mode: v('u', PERSIST_UNTIL_REVOKED),
        ...(restore ? { restore_token: v('s', restore) } : {}),
      },
    ]);
    // Absolute pointer motion needs a screen stream to be relative to.
    await this.#request(SC, 'SelectSources', 'oa{sv}', (handle) => [
      session,
      { handle_token: v('s', handle), types: v('u', SOURCE_MONITOR), multiple: v('b', true) },
    ]);
    this.log('[input] Wayland : une fenêtre du système demande d’autoriser le contrôle à distance sur cet ordinateur');
    const started = await this.#request(RD, 'Start', 'osa{sv}', (handle) => [session, '', { handle_token: v('s', handle) }], START_TIMEOUT_MS);

    const devices = Number(unwrap(started.devices) ?? 0);
    if ((devices & DEVICE_KEYBOARD_POINTER) !== DEVICE_KEYBOARD_POINTER) {
      throw new Error('clavier et souris non autorisés dans la fenêtre du système');
    }
    this.streams = parseStreams(started.streams);
    if (!this.streams.length) throw new Error('aucun écran partagé avec le portail');
    const newToken = unwrap(started.restore_token);
    if (typeof newToken === 'string' && newToken) this.tokenStore?.set(newToken);

    if (this.stopped) {
      this.#closeSession();
      return;
    }
    this.ready = true;
    this.log(`[input] Wayland : contrôle autorisé (${this.streams.length} écran${this.streams.length > 1 ? 's' : ''})`);
    const queued = this.queue;
    this.queue = [];
    for (const op of queued) this.#run(op);
  }

  #fail(err) {
    if (this.failed || this.stopped) return;
    this.failed = true;
    this.queue = [];
    this.log(`[input] Wayland : le portail de contrôle à distance est inutilisable (${err?.message ?? err}). Sans lui la souris et le clavier ne peuvent pas être pilotés.`);
    this.#closeSession();
    try {
      this.onFail(err instanceof Error ? err : new Error(String(err)));
    } catch {
      /* the caller's problem */
    }
  }

  /** A portal method that answers asynchronously, through Request.Response. */
  #request(iface, member, signature, build, timeoutMs = 60_000) {
    const handle = this.#token();
    const sender = String(this.bus.name ?? '').replace(/^:/, '').replace(/\./g, '_');
    const requestPath = `${PORTAL_PATH}/request/${sender}/${handle}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestPath);
        reject(new Error(`${member} : pas de réponse du portail`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestPath, {
        resolve: (code, results) => {
          clearTimeout(timer);
          if (code === 0) resolve(results ?? {});
          else reject(new Error(code === 1 ? `${member} : refusé par l’utilisateur` : `${member} : échec (${code})`));
        },
      });
      this.#call(PORTAL, PORTAL_PATH, iface, member, signature, build(handle)).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(requestPath);
        reject(err);
      });
    });
  }

  #onMessage(msg) {
    if (msg.member !== 'Response' || msg.interface !== 'org.freedesktop.portal.Request') return;
    const entry = this.pending.get(msg.path);
    if (!entry) return;
    this.pending.delete(msg.path);
    const [code, results] = msg.body;
    entry.resolve(Number(code), results);
  }

  async #call(destination, objectPath, iface, member, signature, body) {
    // an error reply makes bus.call() reject
    return this.bus.call(new this.Message({ destination, path: objectPath, interface: iface, member, signature, body }));
  }

  #closeSession() {
    if (!this.session || !this.bus) return;
    const session = this.session;
    this.session = null;
    this.#call(PORTAL, session, SESSION, 'Close', '', []).catch(() => {});
  }

  // --- input ------------------------------------------------------------------------------

  #notify(member, signature, args) {
    if (!this.session) return;
    this.#call(PORTAL, PORTAL_PATH, RD, member, `oa{sv}${signature}`, [this.session, {}, ...args]).catch((err) => {
      if (!this.failed) this.log(`[input] Wayland : ${err.message}`);
    });
  }

  #run(op) {
    const [kind, a, b] = op;
    switch (kind) {
      case 'move': {
        const s = pickStream(this.streams, a.rect);
        if (!s) return;
        this.#notify('NotifyPointerMotionAbsolute', 'udd', [s.node, a.nx * Math.max(0, s.w - 1), a.ny * Math.max(0, s.h - 1)]);
        break;
      }
      case 'button':
        this.#notify('NotifyPointerButton', 'iu', [BTN[a], b ? 1 : 0]);
        break;
      case 'axis':
        this.#notify('NotifyPointerAxisDiscrete', 'ui', [a, b]);
        break;
      case 'keycode':
        this.#notify('NotifyKeyboardKeycode', 'iu', [a, b ? 1 : 0]);
        break;
      case 'keysym':
        this.#notify('NotifyKeyboardKeysym', 'iu', [a, b ? 1 : 0]);
        break;
      default:
    }
  }

  #push(op) {
    if (this.stopped || this.failed) return;
    if (this.ready) return this.#run(op);
    // not authorized yet: keep the latest pointer position and a bounded amount of the rest
    if (op[0] === 'move' && this.queue.at(-1)?.[0] === 'move') this.queue.pop();
    this.queue.push(op);
    if (this.queue.length > QUEUE_LIMIT) this.queue.shift();
  }

  moveNormalized(nx, ny, rect) {
    this.#push(['move', { nx, ny, rect }]);
  }
  move() {
    // global pixels are meaningless here: PortableInput uses moveNormalized()
  }
  button(b, down) {
    if (BTN[b]) this.#push(['button', b, down]);
  }
  wheel(dy) {
    const clicks = Math.min(20, Math.max(1, Math.round(Math.abs(dy) / 120)));
    this.#push(['axis', 0, dy > 0 ? -clicks : clicks]); // portal steps: positive = down
  }
  hwheel(dx) {
    const clicks = Math.min(20, Math.max(1, Math.round(Math.abs(dx) / 120)));
    this.#push(['axis', 1, dx > 0 ? clicks : -clicks]);
  }
  key(scan, ext, down) {
    const code = evdevCode(scan, ext);
    if (code !== null) this.#push(['keycode', code, down]);
  }
  text(str) {
    for (const ch of str) {
      const sym = keysymFor(ch);
      this.#push(['keysym', sym, true]);
      this.#push(['keysym', sym, false]);
    }
  }
  stop() {
    this.stopped = true;
    this.queue = [];
    this.#closeSession();
    for (const [, entry] of this.pending) entry.resolve(2);
    this.pending.clear();
    try {
      this.bus?.disconnect?.();
    } catch {
      /* gone */
    }
  }
}

async function defaultConnect() {
  const mod = await import('dbus-next');
  const dbus = mod.default ?? mod;
  const bus = dbus.sessionBus();
  // the unique name (needed to predict the portal's request paths) arrives with the handshake
  if (!bus.name) {
    await new Promise((resolve, reject) => {
      bus.once('connect', resolve);
      bus.once('error', reject);
    });
  }
  return { bus, Message: dbus.Message, Variant: dbus.Variant };
}

/** True in a Wayland session (the variable wins; WAYLAND_DISPLAY alone is a hint). */
export function isWayland(env = process.env) {
  if (env.XDG_SESSION_TYPE) return env.XDG_SESSION_TYPE === 'wayland';
  return Boolean(env.WAYLAND_DISPLAY);
}

/**
 * The input injector for Linux: the desktop portal on Wayland, xdotool on X11. If the portal is
 * refused or missing, xdotool takes over (it still reaches the X11 / XWayland windows).
 */
export function createLinuxInput({ log = () => {}, spawnFn, env = process.env, tokenFile = null, connect } = {}) {
  const xdotool = () => new XdotoolBackend({ spawnFn, log });
  if (!isWayland(env)) return new PortableInput(xdotool());
  const input = new PortableInput(null);
  input.backend = new PortalBackend({
    connect,
    log,
    tokenStore: tokenFile ? fileTokenStore(tokenFile) : null,
    onFail: () => {
      input.backend = xdotool();
    },
  });
  return input;
}

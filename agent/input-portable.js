// Input injection for macOS and Linux. Speaks the same line protocol as input.ps1 (Windows):
//   r <x> <y> <w> <h>      the display the pointer maps onto (global pixels/points)
//   m <nx> <ny>            move, normalized 0..1 over that display
//   b <l|r|m> <d|u>       button down / up
//   w <dy> / h <dx>        vertical / horizontal wheel, 120 = one notch (positive = up / right)
//   k <scan> <ext> <d|u>   key by Windows set-1 scancode
//   u <codepoint>          one UTF-16 code unit of typed text
// The platform-specific part is a small "backend": xdotool on Linux (X11), a long-running
// osascript (JXA + CoreGraphics) on macOS. Wayland sessions do not allow synthetic input from a
// plain program: there the injection silently does nothing (see INSTALLATION.md).
import { spawn } from 'node:child_process';

// [scancode, extended, X11 keysym, macOS virtual key code]
const ROWS = [
  ...[...'qwertyuiop'].map((c, i) => [0x10 + i, 0, c, [12, 13, 14, 15, 17, 16, 32, 34, 31, 35][i]]),
  ...[...'asdfghjkl'].map((c, i) => [0x1e + i, 0, c, [0, 1, 2, 3, 5, 4, 38, 40, 37][i]]),
  ...[...'zxcvbnm'].map((c, i) => [0x2c + i, 0, c, [6, 7, 8, 9, 11, 45, 46][i]]),
  ...[...'1234567890'].map((c, i) => [0x02 + i, 0, c, [18, 19, 20, 21, 23, 22, 26, 28, 25, 29][i]]),
  [0x0c, 0, 'minus', 27], [0x0d, 0, 'equal', 24], [0x1a, 0, 'bracketleft', 33], [0x1b, 0, 'bracketright', 30],
  [0x27, 0, 'semicolon', 41], [0x28, 0, 'apostrophe', 39], [0x29, 0, 'grave', 50], [0x2b, 0, 'backslash', 42],
  [0x33, 0, 'comma', 43], [0x34, 0, 'period', 47], [0x35, 0, 'slash', 44], [0x39, 0, 'space', 49],
  [0x56, 0, 'less', 10],
  [0x01, 0, 'Escape', 53], [0x0e, 0, 'BackSpace', 51], [0x0f, 0, 'Tab', 48], [0x1c, 0, 'Return', 36],
  [0x1d, 0, 'Control_L', 59], [0x2a, 0, 'Shift_L', 56], [0x36, 0, 'Shift_R', 60], [0x38, 0, 'Alt_L', 58],
  [0x3a, 0, 'Caps_Lock', 57], [0x45, 0, 'Num_Lock', 71], [0x46, 0, 'Scroll_Lock', 107],
  ...[122, 120, 99, 118, 96, 97, 98, 100, 101, 109].map((k, i) => [0x3b + i, 0, `F${i + 1}`, k]),
  [0x57, 0, 'F11', 103], [0x58, 0, 'F12', 111],
  [0x52, 0, 'KP_0', 82], [0x4f, 0, 'KP_1', 83], [0x50, 0, 'KP_2', 84], [0x51, 0, 'KP_3', 85], [0x4b, 0, 'KP_4', 86],
  [0x4c, 0, 'KP_5', 87], [0x4d, 0, 'KP_6', 88], [0x47, 0, 'KP_7', 89], [0x48, 0, 'KP_8', 91], [0x49, 0, 'KP_9', 92],
  [0x53, 0, 'KP_Decimal', 65], [0x37, 0, 'KP_Multiply', 67], [0x4e, 0, 'KP_Add', 69], [0x4a, 0, 'KP_Subtract', 78],
  // extended (E0) keys
  [0x1c, 1, 'KP_Enter', 76], [0x1d, 1, 'Control_R', 62], [0x35, 1, 'KP_Divide', 75], [0x38, 1, 'Alt_R', 61],
  [0x47, 1, 'Home', 115], [0x48, 1, 'Up', 126], [0x49, 1, 'Prior', 116], [0x4b, 1, 'Left', 123],
  [0x4d, 1, 'Right', 124], [0x4f, 1, 'End', 119], [0x50, 1, 'Down', 125], [0x51, 1, 'Next', 121],
  [0x52, 1, 'Insert', 114], [0x53, 1, 'Delete', 117], [0x5b, 1, 'Super_L', 55], [0x5c, 1, 'Super_R', 54],
  [0x5d, 1, 'Menu', 110],
];

const BY_SCAN = new Map(ROWS.map(([scan, ext, sym, mac]) => [`${scan}:${ext}`, { sym, mac }]));

/** Windows set-1 scancode -> { sym (X11 keysym name), mac (CGKeyCode) }, or null. */
export const lookupScan = (scan, ext) => BY_SCAN.get(`${scan}:${ext ? 1 : 0}`) ?? null;

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/**
 * @param {object} backend  { move(x,y), button(b,down), wheel(dy), hwheel(dx), key(scan,ext,down), text(str), stop() }
 */
export class PortableInput {
  constructor(backend, { rect = null } = {}) {
    this.backend = backend;
    this.rect = rect;
    this.high = 0; // pending UTF-16 high surrogate
  }

  send(line) {
    const p = String(line).trim().split(/\s+/);
    const n = (i) => Number(p[i]);
    switch (p[0]) {
      case 'r':
        if ([1, 2, 3, 4].every((i) => Number.isFinite(n(i))) && n(3) > 0 && n(4) > 0) {
          this.rect = { x: n(1), y: n(2), w: n(3), h: n(4) };
        }
        break;
      case 'm': {
        if (!this.rect || !Number.isFinite(n(1)) || !Number.isFinite(n(2))) break;
        const { x, y, w, h } = this.rect;
        this.backend.move(Math.round(x + clamp01(n(1)) * (w - 1)), Math.round(y + clamp01(n(2)) * (h - 1)));
        break;
      }
      case 'b':
        if (['l', 'r', 'm'].includes(p[1]) && ['d', 'u'].includes(p[2])) this.backend.button(p[1], p[2] === 'd');
        break;
      case 'w':
        if (Number.isFinite(n(1)) && n(1) !== 0) this.backend.wheel(Math.trunc(n(1)));
        break;
      case 'h':
        if (Number.isFinite(n(1)) && n(1) !== 0) this.backend.hwheel(Math.trunc(n(1)));
        break;
      case 'k':
        if (Number.isInteger(n(1)) && ['d', 'u'].includes(p[3])) this.backend.key(n(1), n(2) === 1, p[3] === 'd');
        break;
      case 'u': {
        const unit = n(1);
        if (!Number.isInteger(unit) || unit < 1 || unit > 0xffff) break;
        if (unit >= 0xd800 && unit <= 0xdbff) {
          this.high = unit;
          break;
        }
        const ch = unit >= 0xdc00 && unit <= 0xdfff && this.high ? String.fromCharCode(this.high, unit) : String.fromCharCode(unit);
        this.high = 0;
        if (!/[\ud800-\udfff]/.test(ch) || ch.length === 2) this.backend.text(ch);
        break;
      }
      default:
    }
  }

  stop() {
    this.backend.stop();
  }
}

// --- Linux: xdotool -------------------------------------------------------------------------

const XBUTTON = { l: '1', m: '2', r: '3' };

/**
 * xdotool backend. Commands are queued and sent in batches (one process runs several commands
 * chained), and consecutive moves collapse into the last one.
 */
export class XdotoolBackend {
  constructor({ spawnFn = spawn, log = () => {} } = {}) {
    this.spawnFn = spawnFn;
    this.log = log;
    this.queue = [];
    this.running = false;
    this.stopped = false;
    this.missing = false;
  }

  #push(...args) {
    if (this.stopped || this.missing) return;
    this.queue.push(args);
    this.#pump();
  }

  #pump() {
    if (this.running || this.missing || this.stopped || this.queue.length === 0) return;
    // keep only the last of a run of moves
    const batch = [];
    for (const cmd of this.queue.splice(0, 40)) {
      if (cmd[0] === 'mousemove' && batch.at(-1)?.[0] === 'mousemove') batch.pop();
      batch.push(cmd);
    }
    this.running = true;
    let child;
    try {
      child = this.spawnFn('xdotool', batch.flat(), { stdio: 'ignore' });
    } catch (err) {
      this.#failed(err);
      return;
    }
    const done = () => {
      this.running = false;
      this.#pump();
    };
    child.on('error', (err) => {
      this.#failed(err);
      done();
    });
    child.on('exit', done);
  }

  #failed(err) {
    this.running = false;
    if (err?.code === 'ENOENT') {
      this.missing = true;
      this.log('[input] xdotool est introuvable : installez-le pour autoriser le contrôle à distance (sudo apt install xdotool)');
    } else this.log(`[input] xdotool : ${err.message}`);
  }

  move(x, y) {
    this.#push('mousemove', String(x), String(y));
  }
  button(b, down) {
    this.#push(down ? 'mousedown' : 'mouseup', XBUTTON[b]);
  }
  wheel(dy) {
    const clicks = Math.min(20, Math.max(1, Math.round(Math.abs(dy) / 120)));
    for (let i = 0; i < clicks; i++) this.#push('click', dy > 0 ? '4' : '5');
  }
  hwheel(dx) {
    const clicks = Math.min(20, Math.max(1, Math.round(Math.abs(dx) / 120)));
    for (let i = 0; i < clicks; i++) this.#push('click', dx > 0 ? '7' : '6');
  }
  key(scan, ext, down) {
    const k = lookupScan(scan, ext);
    if (k) this.#push(down ? 'keydown' : 'keyup', k.sym);
  }
  text(str) {
    this.#push('type', '--delay', '0', '--', str);
  }
  stop() {
    this.stopped = true;
    this.queue = [];
  }
}

// --- macOS: osascript (JXA) -----------------------------------------------------------------

const MAC_FLAGS = { 56: 0x20000, 60: 0x20000, 59: 0x40000, 62: 0x40000, 58: 0x80000, 61: 0x80000, 55: 0x100000, 54: 0x100000 };

/** JXA program: reads one command per line on stdin and posts CoreGraphics events. */
export const MAC_SCRIPT = `
ObjC.import('Cocoa');
const stdin = $.NSFileHandle.fileHandleWithStandardInput;
const se = Application('System Events');
let flags = 0, held = {l:false, r:false, m:false}, px = 0, py = 0, buf = '';
const post = (ev) => { if (flags) $.CGEventSetFlags(ev, flags); $.CGEventPost($.kCGHIDEventTap, ev); };
const T = {
  l: [$.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp, $.kCGEventLeftMouseDragged, $.kCGMouseButtonLeft],
  r: [$.kCGEventRightMouseDown, $.kCGEventRightMouseUp, $.kCGEventRightMouseDragged, $.kCGMouseButtonRight],
  m: [$.kCGEventOtherMouseDown, $.kCGEventOtherMouseUp, $.kCGEventOtherMouseDragged, $.kCGMouseButtonCenter],
};
function handle(line) {
  const p = line.split(' ');
  if (p[0] === 'm') {
    px = Number(p[1]); py = Number(p[2]);
    const b = held.l ? 'l' : held.r ? 'r' : held.m ? 'm' : null;
    const ev = b ? $.CGEventCreateMouseEvent(null, T[b][2], {x: px, y: py}, T[b][3])
                 : $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, {x: px, y: py}, 0);
    post(ev);
  } else if (p[0] === 'b') {
    const down = p[2] === 'd';
    held[p[1]] = down;
    post($.CGEventCreateMouseEvent(null, T[p[1]][down ? 0 : 1], {x: px, y: py}, T[p[1]][3]));
  } else if (p[0] === 'w') {
    post($.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 2, Number(p[1]), Number(p[2] || 0)));
  } else if (p[0] === 'f') {
    flags = Number(p[1]);
  } else if (p[0] === 'k') {
    post($.CGEventCreateKeyboardEvent(null, Number(p[1]), p[2] === 'd'));
  } else if (p[0] === 't') {
    se.keystroke(decodeURIComponent(p[1]));
  }
}
for (;;) {
  const data = stdin.availableData;
  if (!data || data.length === 0) break;
  buf += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) { try { handle(line); } catch (e) {} }
  }
}
`;

export class MacBackend {
  constructor({ spawnFn = spawn, log = () => {} } = {}) {
    this.log = log;
    this.flags = 0;
    this.stopped = false;
    try {
      this.child = spawnFn('osascript', ['-l', 'JavaScript', '-e', MAC_SCRIPT], { stdio: ['pipe', 'ignore', 'pipe'] });
      this.child.stdin.on('error', () => {});
      this.child.stderr?.on('data', (d) => log(`[input] ${String(d).trim()}`));
      this.child.on('error', (err) => log(`[input] osascript : ${err.message}`));
    } catch (err) {
      this.child = null;
      log(`[input] osascript : ${err.message}`);
    }
  }

  #line(text) {
    if (!this.stopped && this.child?.stdin?.writable) this.child.stdin.write(`${text}\n`);
  }

  move(x, y) {
    this.#line(`m ${x} ${y}`);
  }
  button(b, down) {
    this.#line(`b ${b} ${down ? 'd' : 'u'}`);
  }
  wheel(dy) {
    this.#line(`w ${Math.max(-20, Math.min(20, Math.round(dy / 40)))} 0`);
  }
  hwheel(dx) {
    this.#line(`w 0 ${Math.max(-20, Math.min(20, Math.round(dx / 40)))}`);
  }
  key(scan, ext, down) {
    const k = lookupScan(scan, ext);
    if (!k) return;
    // Controller PCs (Windows, Linux) use Ctrl for shortcuts: it becomes Command here.
    let code = k.mac;
    if (code === 59) code = 55;
    else if (code === 62) code = 54;
    const flag = MAC_FLAGS[code];
    if (flag) {
      this.flags = down ? this.flags | flag : this.flags & ~flag;
      this.#line(`f ${this.flags}`);
    }
    this.#line(`k ${code} ${down ? 'd' : 'u'}`);
  }
  text(str) {
    this.#line(`t ${encodeURIComponent(str)}`);
  }
  stop() {
    this.stopped = true;
    try {
      this.child?.kill();
    } catch {
      /* gone */
    }
  }
}

/** The input injector for this OS. */
export function createPortableInput({ platform = process.platform, log = () => {}, spawnFn = spawn } = {}) {
  const backend = platform === 'darwin' ? new MacBackend({ spawnFn, log }) : new XdotoolBackend({ spawnFn, log });
  return new PortableInput(backend);
}

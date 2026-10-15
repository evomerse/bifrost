import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MAC_SCRIPT, MacBackend, PortableInput, XdotoolBackend, lookupScan } from '../agent/input-portable.js';
import { createPortableHelpers } from '../agent/helpers-portable.js';
import { userConfigBase } from '../agent/config.js';
import { KEYMAP } from '../agent/keymap.js';

class FakeBackend {
  calls = [];
  move(x, y) {
    this.calls.push(['move', x, y]);
  }
  button(b, d) {
    this.calls.push(['button', b, d]);
  }
  wheel(n) {
    this.calls.push(['wheel', n]);
  }
  hwheel(n) {
    this.calls.push(['hwheel', n]);
  }
  key(s, e, d) {
    this.calls.push(['key', s, e, d]);
  }
  text(t) {
    this.calls.push(['text', t]);
  }
  stop() {
    this.calls.push(['stop']);
  }
}

test('line protocol: pointer mapping over the display rectangle', () => {
  const b = new FakeBackend();
  const input = new PortableInput(b);
  input.send('m 0.5 0.5'); // no display known yet: ignored
  input.send('r 1920 0 2560 1440');
  input.send('m 0 0');
  input.send('m 1 1');
  input.send('m 2 -3'); // clamped
  assert.deepEqual(b.calls, [['move', 1920, 0], ['move', 4479, 1439], ['move', 4479, 0]]);
});

test('line protocol: buttons, wheel, keys, text, garbage', () => {
  const b = new FakeBackend();
  const input = new PortableInput(b, { rect: { x: 0, y: 0, w: 100, h: 100 } });
  for (const l of ['b l d', 'b r u', 'b x d', 'w 120', 'w 0', 'h -240', 'k 30 0 d', 'k 29 1 u', 'k 30 0 z', 'u 233', 'zzz', '', 'k nan 0 d']) input.send(l);
  assert.deepEqual(b.calls, [
    ['button', 'l', true],
    ['button', 'r', false],
    ['wheel', 120],
    ['hwheel', -240],
    ['key', 30, false, true],
    ['key', 29, true, false],
    ['text', 'é'],
  ]);
});

test('typed text: surrogate pairs are joined, lone surrogates dropped', () => {
  const b = new FakeBackend();
  const input = new PortableInput(b);
  const smile = '😀';
  input.send(`u ${smile.charCodeAt(0)}`);
  input.send(`u ${smile.charCodeAt(1)}`);
  input.send(`u ${0xdc00}`);
  assert.deepEqual(b.calls, [['text', smile]]);
});

test('scancodes: letters, arrows and extended keys', () => {
  assert.equal(lookupScan(0x1e, 0).sym, 'a');
  assert.equal(lookupScan(0x1e, 0).mac, 0);
  assert.equal(lookupScan(0x48, 1).sym, 'Up');
  assert.equal(lookupScan(0x48, 0).sym, 'KP_8');
  assert.equal(lookupScan(0x1c, 1).sym, 'KP_Enter');
  assert.equal(lookupScan(0x7f, 0), null);
  // every key the viewer can send has a translation
  const missing = Object.entries(KEYMAP)
    .filter(([, [scan, ext]]) => !lookupScan(scan, ext))
    .map(([code]) => code);
  assert.deepEqual(missing, []);
});

function fakeSpawn() {
  const runs = [];
  const spawnFn = (file, args) => {
    const child = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), {
      writable: true,
      written: [],
      write(s) {
        this.written.push(s);
      },
    });
    child.stderr = new EventEmitter();
    child.kill = () => {};
    runs.push({ file, args, child });
    return child;
  };
  return { runs, spawnFn };
}

test('xdotool backend: batches commands and collapses consecutive moves', () => {
  const { runs, spawnFn } = fakeSpawn();
  const b = new XdotoolBackend({ spawnFn });
  b.move(1, 1);
  b.move(5, 5);
  b.move(9, 9);
  b.button('l', true);
  b.key(0x1e, false, true);
  b.text('é');
  assert.equal(runs.length, 1, 'one process at a time');
  assert.deepEqual(runs[0].args, ['mousemove', '1', '1']);
  runs[0].child.emit('exit');
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[1].args, ['mousemove', '9', '9', 'mousedown', '1', 'keydown', 'a', 'type', '--delay', '0', '--', 'é']);
});

test('xdotool backend: wheel clicks, and a missing binary is reported once', () => {
  const { runs, spawnFn } = fakeSpawn();
  const logs = [];
  const b = new XdotoolBackend({ spawnFn, log: (m) => logs.push(m) });
  b.wheel(240);
  assert.deepEqual(runs[0].args, ['click', '4']);
  runs[0].child.emit('error', Object.assign(new Error('nope'), { code: 'ENOENT' }));
  b.move(1, 1);
  b.move(2, 2);
  assert.equal(runs.length, 1, 'no more attempts once xdotool is known to be missing');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /xdotool/);
});

test('macOS backend: Ctrl becomes Command, modifier flags are tracked', () => {
  const { runs, spawnFn } = fakeSpawn();
  const b = new MacBackend({ spawnFn });
  assert.equal(runs[0].file, 'osascript');
  assert.deepEqual(runs[0].args.slice(0, 2), ['-l', 'JavaScript']);
  assert.equal(runs[0].args[3], MAC_SCRIPT);
  b.key(0x1d, false, true); // Ctrl down
  b.key(0x2e, false, true); // C down
  b.key(0x2e, false, false);
  b.key(0x1d, false, false);
  b.move(10, 20);
  b.button('l', true);
  b.wheel(120);
  b.text('é');
  const lines = runs[0].child.stdin.written.join('').trim().split('\n');
  assert.deepEqual(lines, ['f 1048576', 'k 55 d', 'k 8 d', 'k 8 u', 'f 0', 'k 55 u', 'm 10 20', 'b l d', 'w 3 0', 't %C3%A9']);
  b.stop();
  b.move(1, 1);
  assert.equal(runs[0].child.stdin.written.length, lines.length, 'nothing after stop');
});

test('macOS script is syntactically valid JavaScript', () => {
  assert.doesNotThrow(() => new Function(MAC_SCRIPT));
});

test('portable clipboard: forwards local changes, does not echo its own writes', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    let text = 'start';
    const clipboard = {
      readText: () => text,
      writeText: (t) => {
        text = t;
      },
    };
    const helpers = createPortableHelpers({ clipboard, capture: {}, createInput: () => ({ send() {}, stop() {} }) });
    const changes = [];
    const acks = [];
    const c = helpers.startClipboard({ onChange: (t) => changes.push(t), onSet: (ok) => acks.push(ok) });

    mock.timers.tick(600);
    assert.deepEqual(changes, [], 'unchanged');
    text = 'copied locally';
    mock.timers.tick(600);
    assert.deepEqual(changes, ['copied locally']);

    c.set('from the viewer');
    assert.deepEqual(acks, [true]);
    mock.timers.tick(600);
    assert.deepEqual(changes, ['copied locally'], 'our own write is not reported back');
    c.stop();
  } finally {
    mock.timers.reset();
  }
});

test('settings folder follows each OS convention', () => {
  assert.equal(userConfigBase('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\Users\\a'), 'C:\\Users\\a\\AppData\\Roaming');
  assert.match(userConfigBase('darwin', {}, '/Users/a').replace(/\\/g, '/'), /Users\/a\/Library\/Application Support$/);
  assert.equal(userConfigBase('linux', { XDG_CONFIG_HOME: '/x/cfg' }, '/home/a'), '/x/cfg');
  assert.match(userConfigBase('linux', {}, '/home/a').replace(/\\/g, '/'), /home\/a\/\.config$/);
});

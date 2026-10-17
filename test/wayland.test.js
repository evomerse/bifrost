import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PortableInput } from '../agent/input-portable.js';
import { PortalBackend, createLinuxInput, evdevCode, isWayland, keysymFor, parseStreams, pickStream } from '../agent/input-wayland.js';

class Variant {
  constructor(signature, value) {
    this.signature = signature;
    this.value = value;
  }
}
class Message {
  constructor(o) {
    Object.assign(this, o);
  }
}

/**
 * A stand-in for the session bus: answers the portal handshake. `answers` lets a test change what
 * the portal says (a refusal, no devices...).
 */
function fakeBus({ answers = {}, streams = [[7, { position: new Variant('(ii)', [0, 0]), size: new Variant('(ii)', [1920, 1080]) }]] } = {}) {
  const bus = new EventEmitter();
  bus.name = ':1.42';
  bus.calls = [];
  bus.disconnected = false;
  bus.disconnect = () => {
    bus.disconnected = true;
  };
  const respond = (msg, code, results) => {
    const handle = msg.body[msg.body.length - 1].handle_token.value;
    const path = `/org/freedesktop/portal/desktop/request/1_42/${handle}`;
    setImmediate(() => bus.emit('message', new Message({ type: 4, interface: 'org.freedesktop.portal.Request', member: 'Response', path, body: [code, results] })));
  };
  bus.call = async (msg) => {
    bus.calls.push(msg);
    const answer = answers[msg.member];
    switch (msg.member) {
      case 'CreateSession':
        respond(msg, 0, { session_handle: new Variant('s', '/org/freedesktop/portal/desktop/session/1_42/s1') });
        break;
      case 'SelectDevices':
      case 'SelectSources':
        respond(msg, answer ?? 0, {});
        break;
      case 'Start':
        respond(msg, answer ?? 0, {
          devices: new Variant('u', 'devices' in answers ? answers.devices : 3),
          streams: new Variant('a(ua{sv})', streams),
          restore_token: new Variant('s', 'tok-1'),
        });
        break;
      default:
    }
    return null;
  };
  return bus;
}

const connectTo = (bus) => async () => ({ bus, Message, Variant });
const until = async (cond, ms = 1000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 2));
  }
};
const notifications = (bus) => bus.calls.filter((c) => c.member.startsWith('Notify'));

test('wayland: scancodes map to evdev codes, extended ones included', () => {
  assert.equal(evdevCode(0x1e, false), 30); // A
  assert.equal(evdevCode(0x1c, false), 28); // Enter
  assert.equal(evdevCode(0x1c, true), 96); // keypad Enter
  assert.equal(evdevCode(0x48, true), 103); // Up
  assert.equal(evdevCode(0x53, true), 111); // Delete
  assert.equal(evdevCode(0x5b, true), 125); // Super
  assert.equal(evdevCode(0x7f, false), null);
});

test('wayland: typed characters become keysyms', () => {
  assert.equal(keysymFor('a'), 0x61);
  assert.equal(keysymFor('\n'), 0xff0d);
  assert.equal(keysymFor('é'), 0x01000000 + 0xe9);
  assert.equal(keysymFor('😀'), 0x01000000 + 0x1f600);
});

test('wayland: session type detection', () => {
  assert.equal(isWayland({ XDG_SESSION_TYPE: 'wayland' }), true);
  assert.equal(isWayland({ XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: 'wayland-0' }), false);
  assert.equal(isWayland({ WAYLAND_DISPLAY: 'wayland-0' }), true);
  assert.equal(isWayland({}), false);
});

test('wayland: streams are parsed and the right monitor is picked', () => {
  const streams = parseStreams(
    new Variant('a(ua{sv})', [
      [5, { position: new Variant('(ii)', [0, 0]), size: new Variant('(ii)', [1920, 1080]) }],
      [6, { position: new Variant('(ii)', [1920, 0]), size: new Variant('(ii)', [1280, 1024]) }],
    ]),
  );
  assert.deepEqual(streams[1], { node: 6, x: 1920, y: 0, w: 1280, h: 1024 });
  assert.equal(pickStream(streams, { x: 0, y: 0, w: 1920, h: 1080 }).node, 5);
  assert.equal(pickStream(streams, { x: 1920, y: 0, w: 1280, h: 1024 }).node, 6);
  // a 2x display: physical pixels are twice the logical ones
  assert.equal(pickStream(streams, { x: 3840, y: 0, w: 2560, h: 2048 }).node, 6);
  assert.equal(pickStream([streams[0]], { x: 99, y: 99, w: 5, h: 5 }).node, 5);
  assert.equal(pickStream([], null), null);
});

test('wayland: handshake, then pointer and keyboard events reach the portal', async () => {
  const bus = fakeBus();
  const stored = [];
  const logs = [];
  const backend = new PortalBackend({ connect: connectTo(bus), tokenStore: { get: () => 'old', set: (t) => stored.push(t) }, log: (m) => logs.push(m) });
  const input = new PortableInput(backend);

  // sent while the system dialog is still open: kept, in order
  input.send('r 0 0 1920 1080');
  input.send('m 0.5 0.5');
  input.send('b l d');
  await until(() => backend.ready);

  const members = bus.calls.map((c) => c.member);
  assert.deepEqual(members.slice(0, 5), ['AddMatch', 'CreateSession', 'SelectDevices', 'SelectSources', 'Start']);
  const devices = bus.calls[2].body[1];
  assert.equal(devices.types.value, 3);
  assert.equal(devices.restore_token.value, 'old');
  assert.equal(bus.calls[3].interface, 'org.freedesktop.portal.ScreenCast');
  assert.deepEqual(stored, ['tok-1']);

  await until(() => notifications(bus).length === 2);
  const [move, down] = notifications(bus);
  assert.equal(move.member, 'NotifyPointerMotionAbsolute');
  assert.equal(move.signature, 'oa{sv}udd');
  assert.deepEqual(move.body.slice(2), [7, 0.5 * 1919, 0.5 * 1079]);
  assert.equal(down.member, 'NotifyPointerButton');
  assert.deepEqual(down.body.slice(2), [0x110, 1]);

  input.send('w 120');
  input.send('h -240');
  input.send('k 30 0 d'); // A
  input.send('k 30 0 u');
  input.send('k 77 1 d'); // Right (extended)
  input.send('u 233'); // é
  input.send('b r u');
  await until(() => notifications(bus).length === 10);
  const sent = notifications(bus).slice(2).map((c) => [c.member, ...c.body.slice(2)]);
  assert.deepEqual(sent, [
    ['NotifyPointerAxisDiscrete', 0, -1], // wheel up = negative steps
    ['NotifyPointerAxisDiscrete', 1, -2], // left
    ['NotifyKeyboardKeycode', 30, 1],
    ['NotifyKeyboardKeycode', 30, 0],
    ['NotifyKeyboardKeycode', 106, 1],
    ['NotifyKeyboardKeysym', 0x01000000 + 233, 1],
    ['NotifyKeyboardKeysym', 0x01000000 + 233, 0],
    ['NotifyPointerButton', 0x111, 0],
  ]);
  assert.ok(logs.some((m) => /contrôle autorisé/.test(m)));
  assert.ok(notifications(bus).every((c) => c.destination === 'org.freedesktop.portal.Desktop' && c.body[0] === '/org/freedesktop/portal/desktop/session/1_42/s1'));

  input.stop();
  assert.ok(bus.calls.some((c) => c.member === 'Close' && c.path.endsWith('/s1')));
  assert.equal(bus.disconnected, true);
});

test('wayland: a refusal in the system dialog is reported and hands over to xdotool', async () => {
  const bus = fakeBus({ answers: { Start: 1 } });
  const logs = [];
  const spawned = [];
  const fakeChild = () => Object.assign(new EventEmitter(), { stdin: null });
  const input = createLinuxInput({
    env: { XDG_SESSION_TYPE: 'wayland' },
    connect: connectTo(bus),
    log: (m) => logs.push(m),
    spawnFn: (file, args) => {
      spawned.push([file, ...args]);
      return fakeChild();
    },
  });
  await until(() => logs.some((m) => /inutilisable/.test(m)));
  assert.match(logs.at(-1), /refusé/);
  input.send('r 0 0 100 100');
  input.send('m 0 0');
  assert.deepEqual(spawned, [['xdotool', 'mousemove', '0', '0']]);
  assert.ok(bus.calls.some((c) => c.member === 'Close'), 'the half-open portal session is closed');
  input.stop();
});

test('wayland: no keyboard/pointer granted is a failure', async () => {
  const bus = fakeBus({ answers: { devices: 0 } });
  const logs = [];
  let failed = null;
  new PortalBackend({ connect: connectTo(bus), log: (m) => logs.push(m), onFail: (e) => (failed = e) });
  await until(() => failed);
  assert.match(failed.message, /non autorisés/);
});

test('wayland: a missing D-Bus library or bus is a failure, not a crash', async () => {
  let failed = null;
  new PortalBackend({
    connect: async () => {
      throw new Error('ENOENT dbus');
    },
    onFail: (e) => (failed = e),
  });
  await until(() => failed);
  assert.match(failed.message, /dbus/);
});

test('wayland: X11 sessions keep using xdotool', () => {
  const input = createLinuxInput({ env: { XDG_SESSION_TYPE: 'x11' }, spawnFn: () => assert.fail('nothing to spawn yet') });
  assert.equal(input.backend.constructor.name, 'XdotoolBackend');
});

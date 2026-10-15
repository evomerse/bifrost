// The native capture helper (BifrostCapture.exe): built with Windows' csc.exe, then
//  - its self-test encodes synthetic frames and has Windows' own decoder verify them,
//  - the real capture streams H.264 / JPEG records in the expected wire format.
// The streaming tests grab the primary screen into memory only; nothing is written to disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { buildCaptureExe, cscPath, waitUntilUsable } from '../agent/native-build.js';
import { RecordParser, parseCaptureStatus, parseMonitorReport } from '../agent/helpers.js';
import { codecStringFromAnnexB } from '../shared/e2e.js';

const skip = process.platform !== 'win32' || !cscPath();
let exe = null;

function build() {
  if (!exe) {
    exe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bf-cap-')), 'BifrostCapture.exe');
    buildCaptureExe({ outFile: exe });
    assert.ok(waitUntilUsable(exe, 20_000), 'the built helper became usable');
  }
  return exe;
}

/** NAL unit types of an Annex B buffer. */
function nalTypes(buf) {
  const types = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      types.push(buf[i + 3] & 0x1f);
      i += 3;
    }
  }
  return types;
}

/** Runs the helper and collects records until `done(records)` or the timeout. */
function capture(args, { done, timeoutMs = 25_000, onStart, onMonitors, onFrameSeen } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(build(), args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = { status: null, frames: [], stderr: '', notes: [] };
    let finished = false;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(out);
    };
    const timer = setTimeout(
      () => finish(new Error(`timeout; status=${out.status} frames=${out.frames.length} stderr=${out.stderr}`)),
      timeoutMs,
    );
    child.stderr.on('data', (d) => (out.stderr += d));
    child.on('error', finish);
    child.on('exit', (code) => finish(out.frames.length ? null : new Error(`exited ${code}: ${out.stderr}`)));
    const parser = new RecordParser({
      onStatus: (s) => {
        // 'h264' | 'jpeg' is the codec; the others (secure, pointer...) are notes that may follow it
        if (parseCaptureStatus(s)?.codec) {
          out.status = s;
          onStart?.(child);
        } else out.notes.push(s);
      },
      onFrame: (f) => {
        out.frames.push({ ...f, data: Buffer.from(f.data), at: Date.now() });
        onFrameSeen?.(f, child);
        if (done(out)) finish();
      },
      onMonitors,
    });
    child.stdout.on('data', (c) => {
      try {
        parser.push(c);
      } catch (e) {
        finish(e);
      }
    });
  });
}

test('the capture helper builds and its encode/decode self-test passes', { skip, timeout: 120_000 }, () => {
  const r = spawnSync(build(), ['--selftest'], { encoding: 'utf8', timeout: 90_000 });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /SELFTEST OK frames=45 keyframes=2/);
  const worst = Number(/worstLumaError=([\d.]+)/.exec(r.stdout)[1]);
  assert.ok(worst < 4, `luma error ${worst}`);
});

test('H.264 stream: status, then a keyframe carrying SPS+PPS+IDR at the right size', { skip, timeout: 60_000 }, async () => {
  const out = await capture(['--codec', 'h264', '--fps', '15', '--maxwidth', '960', '--bitrate', '2000000'], {
    done: (o) => o.frames.length >= 6,
  });
  assert.equal(out.status, 'h264');
  const first = out.frames[0];
  assert.equal(first.kind, 'h264');
  assert.equal(first.key, true);
  const types = nalTypes(first.data);
  assert.ok(types.includes(7) && types.includes(8) && types.includes(5), `NAL types ${types}`);
  assert.match(codecStringFromAnnexB(first.data), /^avc1\.[0-9a-f]{6}$/);
  assert.ok(first.width > 0 && first.width <= 960 && first.width % 2 === 0, `width ${first.width}`);
  assert.ok(first.height > 0 && first.height % 2 === 0, `height ${first.height}`);
  for (const f of out.frames) {
    assert.equal(f.kind, 'h264');
    assert.equal(f.width, first.width);
    assert.equal(f.height, first.height);
  }
});

test('a keyframe can be requested on demand', { skip, timeout: 60_000 }, async () => {
  let asked = false;
  let keysBefore = 0;
  const out = await capture(['--codec', 'h264', '--fps', '20', '--maxwidth', '640'], {
    onStart: (child) => {
      // Ask for keyframes repeatedly: the screen may be static, so allow a few tries.
      const t = setInterval(() => {
        if (!child.stdin.writable) return clearInterval(t);
        child.stdin.write('K\n');
        asked = true;
      }, 700);
      child.on('exit', () => clearInterval(t));
    },
    done: (o) => {
      const keys = o.frames.filter((f) => f.key).length;
      if (asked && keysBefore === 0) keysBefore = keys;
      return keys >= 3;
    },
    timeoutMs: 30_000,
  });
  assert.ok(out.frames.filter((f) => f.key).length >= 3, 'keyframes on demand');
});

test('JPEG mode still works from the same helper', { skip, timeout: 60_000 }, async () => {
  const out = await capture(['--codec', 'jpeg', '--fps', '10', '--maxwidth', '800', '--quality', '40'], {
    done: (o) => o.frames.length >= 2,
  });
  assert.equal(out.status, 'jpeg');
  const f = out.frames[0];
  assert.equal(f.kind, 'jpeg');
  assert.deepEqual([...f.data.subarray(0, 2)], [0xff, 0xd8]);
  assert.deepEqual([...f.data.subarray(-2)], [0xff, 0xd9]);
  assert.ok(f.width <= 800);
});

test('the helper exits when the agent closes its stdin', { skip, timeout: 60_000 }, async () => {
  const child = spawn(build(), ['--codec', 'jpeg', '--fps', '5'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdout.resume();
  await new Promise((r) => setTimeout(r, 1500));
  child.stdin.end();
  const code = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('helper did not exit')), 10_000);
    child.on('exit', (c) => (clearTimeout(t), resolve(c)));
  });
  assert.equal(code, 0);
});

test('monitor report: validated, primary first, bad data dropped', () => {
  const ok = parseMonitorReport('{"current":1,"list":[{"x":0,"y":0,"w":2560,"h":1440,"p":1},{"x":-1920,"y":0,"w":1920,"h":1080,"p":0}]}');
  assert.deepEqual(ok, {
    current: 1,
    list: [
      { x: 0, y: 0, w: 2560, h: 1440, primary: true },
      { x: -1920, y: 0, w: 1920, h: 1080, primary: false },
    ],
  });
  assert.equal(parseMonitorReport('{"current":9,"list":[{"x":0,"y":0,"w":10,"h":10,"p":1}]}').current, 0, 'current clamped');
  for (const bad of ['not json', '{}', '{"list":[]}', '{"list":[{"x":0,"y":0,"w":0,"h":10}]}', '{"list":[{"x":"0","y":0,"w":1,"h":1}]}',
    JSON.stringify({ list: Array.from({ length: 17 }, () => ({ x: 0, y: 0, w: 1, h: 1 })) })]) {
    assert.equal(parseMonitorReport(bad), null, bad);
  }
});

test('the helper reports its displays before the first frame and follows a display request', { skip, timeout: 60_000 }, async () => {
  const reports = [];
  let order = [];
  const out = await capture(['--codec', 'jpeg', '--fps', '10', '--maxwidth', '640', '--monitor', '0'], {
    onStart: (child) => {
      const t = setInterval(() => {
        if (!child.stdin.writable) return clearInterval(t);
        child.stdin.write('M 0\n');
      }, 500);
      child.on('exit', () => clearInterval(t));
    },
    done: (o) => o.frames.length >= 3,
    onMonitors: (r) => {
      reports.push(r);
      order.push('monitors');
    },
    onFrameSeen: () => order.push('frame'),
  });
  assert.ok(out.frames.length >= 3);
  assert.ok(reports.length >= 1, 'a monitors report was sent');
  assert.equal(order[0], 'monitors', 'the report precedes the first frame');
  const first = reports[0];
  assert.equal(first.current, 0);
  assert.equal(first.list[0].primary, true, 'index 0 is the primary display');
  assert.equal(first.list.filter((m) => m.primary).length, 1);
  assert.deepEqual([first.list[0].x, first.list[0].y], [0, 0], 'the primary display sits at the origin');
  // The frame is the primary display, scaled down to at most 640 wide, same aspect ratio.
  const f = out.frames[0];
  assert.ok(f.width <= 640);
  assert.ok(Math.abs(f.width / f.height - first.list[0].w / first.list[0].h) < 0.02);
});

test('an unknown display index falls back to the primary one', { skip, timeout: 60_000 }, async () => {
  const reports = [];
  await capture(['--codec', 'jpeg', '--fps', '10', '--maxwidth', '320', '--monitor', '57'], {
    done: (o) => o.frames.length >= 1,
    onMonitors: (r) => reports.push(r),
  });
  assert.equal(reports[0].current, 0);
});

test('with several displays, the second one can be captured (skipped on a single-display machine)', { skip, timeout: 60_000 }, async () => {
  const reports = [];
  let asked = false;
  let secondFrame = null;
  await capture(['--codec', 'jpeg', '--fps', '10', '--maxwidth', '4000'], {
    onStart: () => {},
    onMonitors: (r) => reports.push(r),
    onFrameSeen: (f, child) => {
      const list = reports.at(-1)?.list ?? [];
      if (list.length < 2) return;
      if (!asked) {
        asked = true;
        child.stdin.write('M 1\n');
      } else if (reports.at(-1).current === 1 && !secondFrame && f.width === list[1].w - (list[1].w % 2)) {
        secondFrame = f;
      }
    },
    done: () => secondFrame !== null || (reports.length > 0 && reports[0].list.length < 2),
    timeoutMs: 25_000,
  }).catch((err) => {
    if (reports[0]?.list.length >= 2) throw err;
  });
  if (reports[0]?.list.length >= 2) {
    assert.equal(reports.at(-1).current, 1);
    assert.ok(secondFrame, 'a frame of the second display arrived');
  }
});

test('record parser reassembles records split across chunks', () => {
  const frames = [];
  const statuses = [];
  const parser = new RecordParser({ onStatus: (s) => statuses.push(s), onFrame: (f) => frames.push(f) });
  const rec = (type, flags, w, h, payload) => {
    const head = Buffer.alloc(10);
    head[0] = type;
    head[1] = flags;
    head.writeUInt16BE(w, 2);
    head.writeUInt16BE(h, 4);
    head.writeUInt32BE(payload.length, 6);
    return Buffer.concat([head, payload]);
  };
  const wire = Buffer.concat([
    rec(0, 0, 0, 0, Buffer.from('h264')),
    rec(2, 1, 1280, 720, Buffer.from([0, 0, 0, 1, 0x65, 7])),
    rec(2, 0, 1280, 720, Buffer.from([0, 0, 0, 1, 0x41, 8])),
    rec(1, 1, 800, 600, Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
  ]);
  for (let i = 0; i < wire.length; i += 7) parser.push(wire.subarray(i, i + 7));
  assert.deepEqual(statuses, ['h264']);
  assert.deepEqual(frames.map((f) => [f.kind, f.key, f.width, f.height]), [
    ['h264', true, 1280, 720],
    ['h264', false, 1280, 720],
    ['jpeg', true, 800, 600],
  ]);
  assert.throws(() => new RecordParser({}).push(Buffer.from([2, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff])));
});

test('capture status lines: codec, secure desktop, pointer, errors', () => {
  assert.deepEqual(parseCaptureStatus('h264'), { codec: 'h264' });
  assert.deepEqual(parseCaptureStatus('jpeg'), { codec: 'jpeg' });
  assert.deepEqual(parseCaptureStatus('secure'), { secure: true });
  assert.deepEqual(parseCaptureStatus('secure-off'), { secure: false });
  assert.deepEqual(parseCaptureStatus('pointer'), { pointer: true });
  assert.deepEqual(parseCaptureStatus('pointer-off'), { pointer: false });
  assert.deepEqual(parseCaptureStatus('error: boom'), { error: 'error: boom' });
  assert.equal(parseCaptureStatus('whatever'), null);
  assert.equal(parseCaptureStatus(undefined), null);
});

test('the helper tells whether the pointer is in the picture and never claims a secure desktop on a normal one', { skip, timeout: 60_000 }, async () => {
  const out = await capture(['--codec', 'jpeg', '--fps', '10'], { done: (o) => o.frames.length >= 3 && o.notes.length >= 1 });
  assert.ok(out.notes.some((n) => n === 'pointer' || n === 'pointer-off'), `pointer state reported (got ${out.notes})`);
  assert.equal(out.notes.includes('secure'), false, 'an ordinary unlocked desktop is not a secure desktop');
});

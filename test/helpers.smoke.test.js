// Runs the real PowerShell helpers. Windows only.
// The capture test grabs one frame of the primary screen into memory to check the wire
// format (JPEG magic bytes and size). Nothing is written to disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FrameParser } from '../agent/frames.js';

const AGENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent');
const PS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];
const skip = process.platform !== 'win32';

test('capture.ps1 streams valid JPEG frames', { skip, timeout: 60_000 }, async () => {
  const child = spawn('powershell.exe', [...PS, path.join(AGENT, 'capture.ps1'), '-Fps', '5', '-MaxWidth', '800'], {
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  let timer;
  const frame = await new Promise((resolve, reject) => {
    const parser = new FrameParser((width, height, jpeg) => resolve({ width, height, jpeg: Buffer.from(jpeg) }));
    child.stdout.on('data', (c) => {
      try {
        parser.push(c);
      } catch (e) {
        reject(e);
      }
    });
    child.on('exit', (code) => reject(new Error(`capture exited ${code}: ${stderr}`)));
    timer = setTimeout(() => reject(new Error(`no frame in time: ${stderr}`)), 45_000);
  }).finally(() => {
    clearTimeout(timer);
    child.kill();
  });

  assert.deepEqual([...frame.jpeg.subarray(0, 2)], [0xff, 0xd8], 'JPEG SOI');
  assert.deepEqual([...frame.jpeg.subarray(-2)], [0xff, 0xd9], 'JPEG EOI');
  assert.ok(frame.width > 0 && frame.width <= 800);
  assert.ok(frame.height > 0);
});

test('input.ps1 parses commands (dry run, nothing injected)', { skip, timeout: 60_000 }, async () => {
  const child = spawn('powershell.exe', [...PS, path.join(AGENT, 'input.ps1'), '-DryRun'], { windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const lines = ['m 0.50000 0.25000', 'b l d', 'b l u', 'w 120', 'k 30 0 d', 'u 233'];
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout, got: ${out}`)), 45_000);
    const check = setInterval(() => {
      if (out.includes('READY') && !check.sent) {
        check.sent = true;
        child.stdin.write(lines.join('\n') + '\n');
      }
      if (lines.every((l) => out.includes(`DRY ${l}`))) {
        clearTimeout(t);
        clearInterval(check);
        resolve();
      }
    }, 100);
  }).finally(() => child.kill());
  assert.match(out, /DRY k 30 0 d/);
});

test('input.ps1 maps the pointer onto the chosen display, including one left of the primary', { skip, timeout: 60_000 }, async () => {
  const child = spawn('powershell.exe', [...PS, path.join(AGENT, 'input.ps1'), '-DryRun'], { windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const lines = ['r -1920 0 1920 1080', 'm 0.00000 0.00000', 'm 1.00000 1.00000', 'r 100 50 801 601', 'm 0.50000 0.50000'];
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout, got: ${out}`)), 45_000);
    const check = setInterval(() => {
      if (out.includes('READY') && !check.sent) {
        check.sent = true;
        child.stdin.write(lines.join('\n') + '\n');
      }
      if ((out.match(/^AT /gm) ?? []).length >= 3) {
        clearTimeout(t);
        clearInterval(check);
        resolve();
      }
    }, 100);
  }).finally(() => child.kill());
  const targets = [...out.matchAll(/^AT (-?\d+) (-?\d+)/gm)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.deepEqual(targets, [
    [-1920, 0], // top-left corner of a display left of the primary
    [-1, 1079], // bottom-right corner, 1920x1080
    [500, 350], // 100 + 0.5*800, 50 + 0.5*600
  ]);
});

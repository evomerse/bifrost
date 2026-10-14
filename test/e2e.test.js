// End-to-end: real server + real agent process + a scripted viewer, password flow, view-only,
// full encryption. Opt-in (BIFROST_E2E=1) because it briefly shows the red "session active"
// banner and streams real screen frames (kept in memory only). Uses a throw-away APPDATA.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createBifrostServer } from '../server/server.js';
import {
  KIND_FRAME,
  KIND_JSON,
  KIND_VIDEO,
  ViewerE2E,
  codecStringFromAnnexB,
  parseJsonBody,
  unpackFrameBody,
  unpackVideoBody,
} from '../shared/e2e.js';
import { ensureIdentity, saveConfig, setPassword } from '../agent/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = process.platform !== 'win32' || process.env.BIFROST_E2E !== '1';

test('viewer connects to the real agent with a password and receives encrypted H.264 video', { skip, timeout: 90_000 }, async () => {
  const server = createBifrostServer({ port: 0, host: '127.0.0.1', dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bf-srv-')) });
  const port = await server.listen();
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-agent-'));
  const cfg = { server: `ws://127.0.0.1:${port}/ws` };
  await ensureIdentity(cfg);
  await setPassword(cfg, 'e2e-test-password');
  saveConfig(cfg, path.join(appData, 'Bifrost', 'agent.json'));

  const agent = spawn(process.execPath, [path.join(ROOT, 'agent', 'agent.js'), 'run'], {
    // Throw-away profile dirs: the agent compiles its capture helper into LOCALAPPDATA.
    env: { ...process.env, APPDATA: appData, LOCALAPPDATA: appData },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let agentLog = '';
  agent.stdout.on('data', (d) => (agentLog += d));
  agent.stderr.on('data', (d) => (agentLog += d));

  const e2e = new ViewerE2E({ id: cfg.id, password: 'e2e-test-password' });
  const viewer = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  viewer.binaryType = 'nodebuffer';
  const rawPackets = [];
  let frame = null;
  let video = null;
  let accepted = false;
  let challenge = null;

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout; accepted=${accepted}\n${agentLog}`)), 80_000);
    const connect = () => viewer.send(JSON.stringify({ t: 'connect', id: cfg.id }));
    viewer.on('open', () => viewer.send(JSON.stringify({ t: 'viewer' })));

    viewer.on('message', async (data, isBinary) => {
      if (isBinary) {
        const packet = new Uint8Array(data);
        rawPackets.push(Buffer.from(packet));
        const { kind, body } = await e2e.channel.open(packet); // queued in arrival order
        if (kind === KIND_JSON && parseJsonBody(body).t === 'accepted') accepted = true;
        if (kind === KIND_VIDEO) {
          const v = unpackVideoBody(body);
          if (v.key && !video) {
            video = v;
            clearTimeout(timer);
            resolve();
          }
        }
        if (kind === KIND_FRAME && !frame) {
          frame = unpackFrameBody(body);
        }
        return;
      }
      const msg = JSON.parse(data.toString());
      if (msg.srv === 'ready') connect();
      else if (msg.srv === 'error' && msg.code === 'offline') setTimeout(connect, 500); // agent still booting
      else if (msg.t === 'challenge') {
        challenge = msg;
        viewer.send(JSON.stringify(await e2e.commitMessage()));
      } else if (msg.t === 'hello-key') {
        viewer.send(JSON.stringify(await e2e.authMessage({ challenge, hpub: msg.hpub, mode: 'view', label: 'e2e', codecs: ['h264', 'jpeg'] })));
      } else if (msg.t === 'denied') reject(new Error(`denied: ${msg.reason}`));
    });
  });

  try {
    await done;
    assert.equal(accepted, true);
    assert.equal(e2e.usedPassword, true);
    assert.ok(video, 'an H.264 keyframe arrived');
    assert.equal(frame, null, 'no JPEG frame once H.264 is negotiated');
    assert.ok(video.width > 0 && video.height > 0 && video.width % 2 === 0);
    assert.match(codecStringFromAnnexB(video.data), /^avc1\.[0-9a-f]{6}$/);
    assert.deepEqual([...video.data.subarray(0, 3)], [0, 0, 0], 'Annex B start code after decryption');
    // What the relay carried must not contain an H.264 start code + SPS header in clear.
    for (const p of rawPackets) assert.equal(p.includes(Buffer.from([0, 0, 0, 1, 0x67])), false);
  } finally {
    viewer.send(JSON.stringify({ t: 'leave' }));
    viewer.close();
    agent.kill();
    await server.close();
  }
});

// Tests of the Windows service pieces that do not need administrator rights:
//  - the staged install layout runs on its own,
//  - the C# service host compiles,
//  - the supervisor (same code as the service, run with --console) starts the agent,
//    restarts it when it dies and cleans up an orphan left by a crashed host.
// Real SYSTEM / secure-desktop behaviour cannot be exercised here: see README "Vérifier".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createBifrostServer } from '../server/server.js';
import { buildServiceExe, cscPath, discardUntrustedData, isTrustedOwner, stageFiles } from '../agent/service.js';
import { ensureIdentity, saveConfig } from '../agent/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = process.platform !== 'win32' || !cscPath();
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(150);
  }
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const killTree = (pid) => spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F']);

/** Resolves true when a viewer can be paired with the host `id` (i.e. the host is online). */
function hostReachable(url, id) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const done = (v) => {
      try {
        ws.close();
      } catch {
        /* closed */
      }
      resolve(v);
    };
    const timer = setTimeout(() => done(false), 3000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'viewer' })));
    ws.on('error', () => done(false));
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m.srv === 'ready') ws.send(JSON.stringify({ t: 'connect', id }));
      else if (m.srv === 'paired') {
        clearTimeout(timer);
        ws.send(JSON.stringify({ t: 'leave' }));
        done(true);
      } else if (m.srv === 'error') {
        clearTimeout(timer);
        done(false);
      }
    });
  });
}

test('staged layout is self-contained and excludes tests', { skip }, () => {
  const dest = tmp('bf-stage-');
  stageFiles({ destDir: dest });
  for (const f of [
    'agent/agent.js', 'agent/session.js', 'agent/native-build.js', 'agent/capture.ps1', 'agent/input.ps1',
    'shared/e2e.js', 'shared/auth.js', 'package.json', 'node_modules/ws/package.json',
  ]) {
    assert.ok(fs.existsSync(path.join(dest, f)), `${f} staged`);
  }
  assert.equal(fs.existsSync(path.join(dest, 'test')), false);

  // The copy must run without the source tree (imports resolve inside the staged dir).
  const r = spawnSync(process.execPath, [path.join(dest, 'agent', 'agent.js'), '--help'], { encoding: 'utf8', cwd: os.tmpdir() });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /service install/);
});

test('service data created by a normal user is not trusted (pre-seeding defence)', { skip }, () => {
  const dir = tmp('bf-seed-');
  const planted = path.join(dir, 'agent.json');
  fs.writeFileSync(planted, JSON.stringify({ server: 'wss://attacker.example/ws', passwordKey: 'AAAA' }));
  assert.equal(isTrustedOwner(dir), false);
  assert.equal(isTrustedOwner(planted), false);

  const report = discardUntrustedData(dir);
  assert.equal(fs.existsSync(dir), false, 'untrusted directory is removed entirely');
  assert.equal(report.length, 1);
  assert.deepEqual(discardUntrustedData(dir), [], 'nothing to do when absent');
});

test('the service host compiles with the csc.exe shipped with Windows', { skip }, () => {
  const out = path.join(tmp('bf-exe-'), 'BifrostService.exe');
  buildServiceExe({ outFile: out });
  assert.ok(fs.statSync(out).size > 5000);
});

test('token-duplication launch path (CreateProcessAsUser) starts a working agent', { skip, timeout: 60_000 }, async () => {
  // Same code path the service uses to put the agent into the console session, exercised
  // with the caller's own token (the real service does this with its SYSTEM token).
  const server = createBifrostServer({ port: 0, host: '127.0.0.1', dataDir: tmp('bf-srvdata-') });
  const port = await server.listen();
  const url = `ws://127.0.0.1:${port}/ws`;
  const stage = tmp('bf-svc-');
  const data = tmp('bf-svcdata-');
  stageFiles({ destDir: stage });
  const exe = path.join(stage, 'BifrostService.exe');
  buildServiceExe({ outFile: exe });
  const cfg = { server: url };
  await ensureIdentity(cfg);
  saveConfig(cfg, path.join(data, 'agent.json'));

  const pidFile = path.join(data, 'agent.pid');
  const supervisor = spawn(exe, ['--console'], {
    env: { ...process.env, BIFROST_DATA_DIR: data, BIFROST_NODE: process.execPath, BIFROST_TEST_TOKEN: '1' },
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    await waitFor(() => fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, 'utf8')), 'agent pid file');
    await waitFor(() => hostReachable(url, cfg.id), 'host online through CreateProcessAsUser');
  } catch (err) {
    const logFile = path.join(data, 'service.log');
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '(no service.log)';
    throw new Error(`${err.message}\n${log}`);
  } finally {
    const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
    if (supervisor.pid) killTree(supervisor.pid);
    if (pid) killTree(pid);
    await server.close();
  }
});

test('supervisor starts the agent, restarts it, and kills an orphan on startup', { skip, timeout: 120_000 }, async () => {
  // Server + stage + data dir
  const server = createBifrostServer({ port: 0, host: '127.0.0.1', dataDir: tmp('bf-srvdata-') });
  const port = await server.listen();
  const url = `ws://127.0.0.1:${port}/ws`;

  const stage = tmp('bf-svc-');
  const data = tmp('bf-svcdata-');
  stageFiles({ destDir: stage });
  const exe = path.join(stage, 'BifrostService.exe');
  buildServiceExe({ outFile: exe });

  const cfg = { server: url };
  await ensureIdentity(cfg);
  saveConfig(cfg, path.join(data, 'agent.json'));

  const env = { ...process.env, BIFROST_DATA_DIR: data, BIFROST_NODE: process.execPath };
  const pidFile = path.join(data, 'agent.pid');
  const readPid = () => {
    try {
      return Number(fs.readFileSync(pidFile, 'utf8').trim()) || 0;
    } catch {
      return 0;
    }
  };

  const hosts = [];
  const supervisors = [];
  const startSupervisor = () => {
    const p = spawn(exe, ['--console'], { env, stdio: 'ignore', windowsHide: true });
    supervisors.push(p);
    return p;
  };

  try {
    // 1. starts the agent, which comes online
    startSupervisor();
    const pid1 = await waitFor(readPid, 'agent pid file');
    await waitFor(() => hostReachable(url, cfg.id), 'host online (first start)');
    assert.ok(isAlive(pid1));
    hosts.push(pid1);

    // 2. agent killed -> supervisor restarts a new one, host comes back
    killTree(pid1);
    const pid2 = await waitFor(() => {
      const p = readPid();
      return p && p !== pid1 ? p : 0;
    }, 'restarted agent pid');
    await waitFor(() => hostReachable(url, cfg.id), 'host online (after restart)');
    assert.equal(isAlive(pid1), false);
    hosts.push(pid2);

    // 3. supervisor itself dies abruptly: the agent is orphaned...
    const first = supervisors[0];
    process.kill(first.pid); // TerminateProcess on the host only, not its children
    await waitFor(() => !isAlive(first.pid), 'supervisor gone');
    assert.ok(isAlive(pid2), 'agent survives a crash of the host (orphan)');

    // ...and the next supervisor start removes it before launching its own.
    startSupervisor();
    const pid3 = await waitFor(() => {
      const p = readPid();
      return p && p !== pid2 ? p : 0;
    }, 'new agent after orphan cleanup');
    hosts.push(pid3);
    await waitFor(() => !isAlive(pid2), 'orphan killed');
    await waitFor(() => hostReachable(url, cfg.id), 'host online (after orphan cleanup)');

    const log = fs.readFileSync(path.join(data, 'service.log'), 'utf8');
    assert.match(log, /agent started/);
    assert.match(log, /killing stale agent/);
  } finally {
    for (const s of supervisors) if (s.pid) killTree(s.pid);
    for (const pid of hosts) killTree(pid);
    killTree(readPid() || 0);
    await server.close();
  }
});

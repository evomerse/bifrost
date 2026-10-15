// The macOS / Linux capture path, exercised on any OS by forcing it (BIFROST_PORTABLE=1):
// relay <- host (Electron getDisplayMedia capture, JPEG frames) <- viewer window.
// View-only on purpose: no input is ever injected. The screen is captured in memory only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBifrostServer } from '../../server/server.js';
import { setPassword } from '../../agent/config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, what, ms = 25_000) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = null;
    }
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(150);
  }
}

export async function run(ctx) {
  const result = { checks: {} };
  const check = (name, ok, detail) => {
    result.checks[name] = detail === undefined ? Boolean(ok) : { ok: Boolean(ok), detail };
  };

  const relay = createBifrostServer({ port: 0, host: '127.0.0.1', dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bf-p-relay-')) });
  const port = await relay.listen();
  const cfg = ctx.cfg;
  cfg.server = `ws://127.0.0.1:${port}/ws`;
  cfg.clipboard = false;
  cfg.fileTransfer = 'deny';
  await setPassword(cfg, 'portable-test-password');
  ctx.saveCfg();
  ctx.restartHosting();
  await until(() => ctx.state().status === 'online', 'host online');

  const win = ctx.openViewer({ id: cfg.id, password: 'portable-test-password', mode: 'view', label: 'test' });
  const page = (expr) => win.webContents.executeJavaScript(expr);
  await until(() => page("document.getElementById('stage') && !document.getElementById('stage').hidden"), 'viewer stage shown', 40_000);
  check('session_accepted', true);

  const stats = await until(async () => {
    const s = await page(`(() => {
      const c = document.getElementById('screen');
      const ctx = c.getContext('2d');
      let painted = 0;
      const seen = new Set();
      for (let i = 0; i < 400; i++) {
        const x = Math.floor((i % 20) * c.width / 20) + 3;
        const y = Math.floor(Math.floor(i / 20) * c.height / 20) + 3;
        if (x >= c.width || y >= c.height) continue;
        const d = ctx.getImageData(x, y, 1, 1).data;
        seen.add(d[0] + ',' + d[1] + ',' + d[2]);
        if (d[3] > 0) painted++;
      }
      return { w: c.width, h: c.height, painted, distinct: seen.size };
    })()`);
    return s.w > 300 && s.painted > 300 ? s : null;
  }, 'pixels painted from Electron capture', 40_000);
  check('canvas_painted_from_electron_capture', stats.painted > 300, stats);
  check('capture_is_jpeg', ctx.host.session?.parts?.capture?.codec === 'jpeg', ctx.host.session?.parts?.capture?.codec);
  check('display_list_reported', Array.isArray(ctx.host.session?.monitorList) && ctx.host.session.monitorList.length >= 1, ctx.host.session?.monitorList);

  ctx.host.endSession();
  await until(() => page("document.getElementById('stage').hidden"), 'viewer back to the card');
  check('host_can_end_session', true);

  win.destroy();
  await relay.close();
  result.failed = Object.entries(result.checks).filter(([, v]) => !(v === true || v?.ok === true)).map(([k]) => k);
  result.error = result.failed.length ? `failed checks: ${result.failed.join(', ')}` : undefined;
  return result;
}

// Drives the real desktop app (Electron) through two scenarios and reads their result files.
// Opt-in (BIFROST_E2E=1): it starts Electron, captures this PC's primary screen into memory and
// briefly shows the red "screen shared" banner. Everything is created in throw-away folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = process.platform !== 'win32' || process.env.BIFROST_E2E !== '1';

function electronExe() {
  const require = createRequire(import.meta.url);
  return require('electron'); // path of electron.exe
}

/** Starts the app with a scenario and resolves with the JSON result it wrote. */
function runApp(scenario, { timeoutMs = 90_000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-dtest-home-'));
    const out = path.join(home, 'result.json');
    const child = spawn(electronExe(), ['.'], {
      cwd: ROOT,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        BIFROST_HOME: path.join(home, 'bifrost'),
        LOCALAPPDATA: path.join(home, 'local'), // the capture helper is compiled into this profile
        APPDATA: path.join(home, 'roaming'),
        BIFROST_DESKTOP_TEST: path.join(ROOT, 'test', 'desktop', scenario),
        BIFROST_DESKTOP_TEST_OUT: out,
        BIFROST_DESKTOP_TEST_TIMEOUT: String(timeoutMs),
        ELECTRON_ENABLE_LOGGING: '0',
        ...env,
      },
    });
    const killer = setTimeout(() => {
      child.kill();
      reject(new Error('the app did not exit in time'));
    }, timeoutMs + 25_000);
    child.on('error', reject);
    child.on('exit', () => {
      clearTimeout(killer);
      try {
        resolve(JSON.parse(fs.readFileSync(out, 'utf8')));
      } catch (err) {
        reject(new Error(`no result file (${err.message})`));
      }
    });
  });
}

test('desktop app: control panel renders, sandboxed, offline relay reported', { skip, timeout: 120_000 }, async () => {
  const r = await runApp('basic.scenario.mjs', { timeoutMs: 40_000 });
  assert.equal(r.error, undefined, r.error);
  assert.match(r.page.id, /^\d{3} \d{3} \d{3}$/);
  assert.equal(r.page.chipClass, 'chip offline');
  assert.equal(r.page.chip, 'Serveur injoignable');
  assert.equal(r.page.hasApi, 'object');
  assert.equal(r.page.nodeLeak, 'undefined/undefined', 'no Node.js in the page');
  assert.equal(r.page.sessionBannerHidden, true);
  assert.equal(r.state.hasPassword, false);
  assert.equal(r.state.fileTransfer, 'ask');

  // Heimdall: off by default, safe links only, key kept out of the settings file in clear text
  const h = r.heimdall;
  assert.equal(h.tabHiddenByDefault, true);
  assert.equal(h.askWhileDisabled.ok, false);
  assert.match(h.askWhileDisabled.error, /désactivé/);
  assert.equal(h.badLink.ok, false);
  assert.match(h.badLink.error, /non autorisée/);
  assert.equal(h.tabShownWhenEnabled, true);
  assert.equal(h.noKeyNotice, true);
  assert.equal(h.askWithoutKey.ok, false);
  assert.match(h.askWithoutKey.error, /Aucune clé API/);
  assert.equal(h.hasKeyAfterSave, true);
  assert.equal(h.keyNotInPlainText, h.protectedKey, 'key encrypted whenever the OS store exists');
  assert.equal(h.badKey.ok, false);
  assert.equal(h.keyCleared, true);
  assert.equal(h.tutorialVisible, true, 'Groq tutorial shown for the default provider');
  assert.equal(h.chatOpens, true);
  assert.equal(h.homeStillVisible, true, 'the chat does not replace the page behind it');
  assert.equal(h.chatFloatsBottomRight, true);
  assert.equal(h.chatNoOverlapButton, true);
  assert.equal(h.escapeCloses, true);
  assert.equal(h.settingsPanelShown, true);
  assert.equal(h.homeHiddenAfter, true);
  assert.equal(r.update.bannerHidden, true);

  // the real logo, and Heimdall / settings floating at the bottom right
  assert.equal(r.layout.logoLoaded, true);
  assert.equal(r.layout.logoIsPng, true);
  assert.equal(r.layout.settingsBottomRight, true);
  assert.equal(r.layout.heimdallBottomRight, true);
  assert.equal(r.layout.effectOnlyOnLogo, true);
  for (const [id, [dx, dy, w, h]] of Object.entries(r.layout.iconOffset)) {
    assert.ok(dx < 0.5 && dy < 0.5, `${id}: icon off-centre by ${dx}/${dy}px`);
    assert.equal(w, h, `${id}: button is not round (${w}x${h})`);
  }
});

test('desktop app: runs the relay itself, reports a busy port', { skip, timeout: 120_000 }, async () => {
  const r = await runApp('relay.scenario.mjs', { timeoutMs: 60_000 });
  assert.deepEqual(r.failed ?? [], [], JSON.stringify(r.checks, null, 2));
  assert.equal(r.error, undefined, r.error);
});

test('desktop app: consent dialog, verification code, banner and Stop', { skip, timeout: 150_000 }, async () => {
  const r = await runApp('consent.scenario.mjs', { timeoutMs: 80_000 });
  assert.deepEqual(r.failed ?? [], [], JSON.stringify(r.checks, null, 2));
  assert.equal(r.error, undefined, r.error);
  assert.match(r.checks.dialog_shows_verification_code.detail, /^\d{3} \d{3}$/);
  assert.equal(r.checks.deny_is_default_focus.ok, true);
});

test('desktop app: host + integrated viewer in Chromium (H.264, password, files, clipboard permissions)', { skip, timeout: 150_000 }, async () => {
  const r = await runApp('session.scenario.mjs', { timeoutMs: 90_000 });
  assert.deepEqual(r.failed ?? [], [], JSON.stringify(r.checks, null, 2));
  assert.equal(r.error, undefined, r.error);
  const c = r.checks;
  assert.ok(c.canvas_painted_by_h264.detail.painted > 300);
  assert.ok(c.video_dimensions.detail.w >= 640);
  assert.equal(c.upload_from_page, true);
  assert.equal(c.download_to_browser.detail, 'completed');
});

test('desktop app: portable capture path (macOS/Linux code) works end to end', { skip, timeout: 150_000 }, async () => {
  const r = await runApp('portable.scenario.mjs', { timeoutMs: 90_000, env: { BIFROST_PORTABLE: '1' } });
  assert.deepEqual(r.failed ?? [], [], JSON.stringify(r.checks, null, 2));
  assert.equal(r.error, undefined, r.error);
});

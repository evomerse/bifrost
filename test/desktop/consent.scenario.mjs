// Consent path of the desktop app, without a password: the person at the PC gets the app's own
// dialog (with the verification code), can refuse or allow, sees the red banner while shared,
// and can stop the session from it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBifrostServer } from '../../server/server.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, what, ms = 20_000) {
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
    await sleep(120);
  }
}

export async function run(ctx) {
  const result = { checks: {} };
  const check = (name, ok, detail) => {
    result.checks[name] = detail === undefined ? Boolean(ok) : { ok: Boolean(ok), detail };
  };

  const relay = createBifrostServer({ port: 0, host: '127.0.0.1', dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bf-c-relay-')) });
  const port = await relay.listen();
  const cfg = ctx.cfg;
  cfg.server = `ws://127.0.0.1:${port}/ws`;
  cfg.transferDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-c-transfers-'));
  delete cfg.passwordKey; // no password: every connection must ask
  ctx.saveCfg();
  ctx.restartHosting();
  await until(() => ctx.state().status === 'online', 'host online');

  const windowsWith = (suffix) =>
    ctx.BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.getURL().endsWith(suffix));
  const consentWindow = () => windowsWith('/consent.html')[0] ?? null;
  const bannerWindow = () => windowsWith('/indicator.html')[0] ?? null;

  // --- round 1: the person refuses -------------------------------------------------------
  const v1 = ctx.openViewer({ id: cfg.id, mode: 'control', label: 'Camille' });
  const dialog = await until(consentWindow, 'consent dialog');
  const dialogText = await until(
    () => dialog.webContents.executeJavaScript(`document.getElementById('text').textContent`),
    'dialog text',
  );
  check('dialog_names_the_requester', /Camille/.test(dialogText) && /non vérifié/.test(dialogText), dialogText);
  const code = /(\d{3} \d{3})/.exec(dialogText)?.[1];
  check('dialog_shows_verification_code', Boolean(code), code);

  // the viewer shows the very same code (this is what the two people compare)
  const viewerStatus = await until(async () => {
    const s = await v1.webContents.executeJavaScript(`document.getElementById('status').textContent`);
    return s.includes('Code de vérification') ? s : null;
  }, 'viewer shows its code');
  check('viewer_code_matches_dialog', viewerStatus.includes(code), { code, viewerStatus });

  // "Refuser" has the focus by default
  const focused = await dialog.webContents.executeJavaScript(`document.activeElement?.id`);
  check('deny_is_default_focus', focused === 'deny', focused);
  await dialog.webContents.executeJavaScript(`document.getElementById('deny').click()`);
  const refused = await until(async () => {
    const s = await v1.webContents.executeJavaScript(`document.getElementById('status').textContent`);
    return /refusé/.test(s) ? s : null;
  }, 'viewer told about the refusal');
  check('refusal_reaches_viewer', true, refused);
  check('no_banner_after_refusal', bannerWindow() === null);
  v1.destroy();

  // --- round 2: the dialog is closed without answering = refusal ---------------------------
  const v2 = ctx.openViewer({ id: cfg.id, mode: 'view', label: 'Camille' });
  const dialog2 = await until(consentWindow, 'second consent dialog');
  dialog2.close();
  const refused2 = await until(async () => {
    const s = await v2.webContents.executeJavaScript(`document.getElementById('status').textContent`);
    return /refusé/.test(s) ? s : null;
  }, 'refusal by closing');
  check('closing_the_dialog_refuses', true, refused2);
  v2.destroy();

  // --- round 3: the person allows ---------------------------------------------------------
  const v3 = ctx.openViewer({ id: cfg.id, mode: 'view', label: 'Camille' });
  const dialog3 = await until(consentWindow, 'third consent dialog');
  await dialog3.webContents.executeJavaScript(`document.getElementById('allow').click()`);
  await until(() => v3.webContents.executeJavaScript(`!document.getElementById('stage').hidden`), 'viewer stage shown');
  check('allow_opens_the_session', true);

  const banner = await until(bannerWindow, 'banner window');
  const bannerText = await until(
    () => banner.webContents.executeJavaScript(`document.querySelector('.bannerbar').innerText`).then((t) => (t.includes('127.0.0.1') ? t : null)),
    'banner text',
  );
  check('banner_visible_with_origin', true, bannerText);
  check('banner_names_the_visitor', bannerText.includes('Camille') && bannerText.includes('lecture seule'), bannerText);
  check('state_reports_active_session', ctx.state().session?.phase === 'active', ctx.state().session);

  // the person stops the session from the banner
  await banner.webContents.executeJavaScript(`document.getElementById('stop').click()`);
  const status = await until(async () => {
    const hidden = await v3.webContents.executeJavaScript(`document.getElementById('stage').hidden`);
    return hidden ? true : null;
  }, 'viewer back to the card after Stop');
  check('stop_button_ends_session', status === true);
  await until(() => bannerWindow() === null, 'banner closed');
  check('banner_closed_after_session', true);
  check('state_cleared', ctx.state().session === null, ctx.state().session);

  v3.destroy();
  await relay.close();
  result.failed = Object.entries(result.checks).filter(([, v]) => !(v === true || v?.ok === true)).map(([k]) => k);
  result.error = result.failed.length ? `failed checks: ${result.failed.join(', ')}` : undefined;
  return result;
}

// End-to-end scenario for the desktop app, in a real Chromium:
//   relay (in this process) <- host (the app's own startHost) <- viewer window (the real viewer)
// It checks what could not be checked before: WebCodecs H.264 decoding of the real screen, the
// encrypted handshake with a password, the clipboard bridge and file transfer from the page.
//
// The host captures this machine's primary screen, in memory only. In control mode the input
// helper starts but no input event is ever sent.
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

  // 1. a relay, and this app's host pointed at it with a password and a file share
  const relay = createBifrostServer({ port: 0, host: '127.0.0.1', dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bf-d-relay-')) });
  const port = await relay.listen();
  const transfers = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-d-transfers-'));
  const outbox = path.join(transfers, 'Outbox');
  fs.mkdirSync(outbox, { recursive: true });
  fs.writeFileSync(path.join(outbox, 'depuis-hote.txt'), 'contenu envoyé par l’hôte ✓');

  const cfg = ctx.cfg;
  cfg.server = `ws://127.0.0.1:${port}/ws`;
  cfg.transferDir = transfers;
  cfg.fileTransfer = 'allow';
  cfg.clipboard = true;
  await setPassword(cfg, 'desktop-test-password');
  ctx.saveCfg();
  ctx.restartHosting();
  await until(() => ctx.state().status === 'online', 'host online on the local relay');
  check('host_online', true);

  // 2. the viewer window, started like the "Se connecter" button does
  const win = ctx.openViewer({ id: cfg.id, password: 'desktop-test-password', mode: 'control', label: 'test' });
  const page = (expr, gesture = false) => win.webContents.executeJavaScript(expr, gesture);

  await until(async () => (await page("document.getElementById('stage') && !document.getElementById('stage').hidden")), 'viewer stage shown');
  check('session_accepted_with_password', true);
  // while controlling, only the host's own pointer is seen
  // one pointer only: the host's own (drawn in the video) when it is there, else a small local ring
  const cursor = await until(
    () => page(`getComputedStyle(document.getElementById('screen')).cursor`).then((c) => (c === 'none' || c.startsWith('url(') ? c : null)),
    'pointer style',
  );
  check('single_pointer_while_controlling', cursor === 'none' || cursor.startsWith('url('), cursor.slice(0, 40));
  check('password_not_kept', ctx.viewerParams.get(win.webContents.id)?.params.password === '');

  // 3. H.264 frames decoded by WebCodecs into the canvas
  const video = await until(async () => {
    const info = await page(`(() => {
      const c = document.getElementById('screen');
      return { w: c.width, h: c.height };
    })()`);
    return info.w > 300 && info.h > 200 ? info : null;
  }, 'canvas sized from decoded frames');
  check('video_dimensions', video.w % 2 === 0 && video.h % 2 === 0, video);

  const stats = await until(async () => {
    const s = await page(`(() => {
      const c = document.getElementById('screen');
      const ctx = c.getContext('2d');
      const seen = new Set();
      let painted = 0;
      for (let i = 0; i < 400; i++) {
        const x = Math.floor((i % 20) * c.width / 20) + 3;
        const y = Math.floor(Math.floor(i / 20) * c.height / 20) + 3;
        const d = ctx.getImageData(x, y, 1, 1).data;
        seen.add(d[0] + ',' + d[1] + ',' + d[2]);
        if (d[3] > 0) painted++;
      }
      return { distinct: seen.size, painted };
    })()`);
    return s.painted > 300 ? s : null;
  }, 'pixels painted');
  check('canvas_painted_by_h264', stats.painted > 300, stats);

  // which codec did the host really negotiate? (the viewer announces h264 first)
  check('host_negotiated_h264', ctx.host.session?.codecs?.includes('h264') ?? false, ctx.host.session?.codecs);

  // 4. the bar shows what the host allows (perm message went through the encrypted channel)
  const ui = await until(async () => {
    const r = await page(`(() => ({
      filesBtn: !document.getElementById('filesBtn').hidden,
      clipBtn: !document.getElementById('clipBtn').hidden,
    }))()`);
    return r.filesBtn && r.clipBtn ? r : null;
  }, 'file and clipboard buttons');
  check('permissions_reached_ui', true, ui);

  // 5. upload from the page: a File assigned to the real <input type=file>
  await page(`(() => {
    document.getElementById('filesBtn').click();
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(100000).fill(65)], 'depuis-navigateur.bin'));
    const input = document.getElementById('upload');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  })()`);
  const inboxFile = path.join(transfers, 'Inbox', 'depuis-navigateur.bin');
  await until(() => fs.existsSync(inboxFile) && fs.statSync(inboxFile).size === 100000, 'uploaded file on the host');
  check('upload_from_page', fs.readFileSync(inboxFile).every((b) => b === 65));

  // 6. download in the page (Blob fallback, so no native save dialog): the listing offers it
  await page(`(() => { window.showSaveFilePicker = undefined; })()`);
  const downloaded = new Promise((resolve) => {
    win.webContents.session.once('will-download', (_e, item) => {
      const target = path.join(transfers, 'telecharge.txt');
      item.setSavePath(target);
      item.once('done', (_e2, state) => resolve({ state, target }));
    });
  });
  await until(async () => page(`document.querySelectorAll('#entries li').length > 0`), 'folder listing rendered');
  // go to Outbox, then press "Télécharger" on depuis-hote.txt
  await page(`(() => {
    const open = [...document.querySelectorAll('#entries button')].find((b) => b.textContent.includes('Outbox'));
    open?.click();
  })()`);
  await until(async () => page(`[...document.querySelectorAll('#entries li')].some((li) => li.textContent.includes('depuis-hote.txt'))`), 'Outbox listing');
  await page(`(() => {
    const li = [...document.querySelectorAll('#entries li')].find((l) => l.textContent.includes('depuis-hote.txt'));
    [...li.querySelectorAll('button')].find((b) => b.textContent.includes('Télécharger')).click();
  })()`);
  const dl = await Promise.race([downloaded, sleep(20_000).then(() => ({ state: 'timeout' }))]);
  check('download_to_browser', dl.state === 'completed' && fs.readFileSync(dl.target, 'utf8') === 'contenu envoyé par l’hôte ✓', dl.state);

  // 7. clipboard permissions of the viewer window. Reading/writing needs a focused window, which a
  //    hidden test window is not, so the permission state itself is checked (the host-side
  //    bridge has its own test against the real helper). Nothing touches the clipboard here.
  const perms = await page(`(async () => {
    const q = async (name) => { try { return (await navigator.permissions.query({ name })).state; } catch (e) { return 'error: ' + e.message; } };
    return { read: await q('clipboard-read'), write: await q('clipboard-write') };
  })()`);
  check('clipboard_permissions_granted_to_viewer', perms.read === 'granted' && perms.write === 'granted', perms);

  // 7b. chat between the two people, end-to-end, gone with the session
  const main = ctx.mainWindow;
  const mainPage = (expr) => main.webContents.executeJavaScript(expr);
  check('chat_button_offered_by_host', await until(async () => page(`!document.getElementById('talkBtn').hidden`), 'chat button in the viewer'));
  await page(`document.getElementById('talkBtn').click()`);
  await page(`(() => {
    document.getElementById('talkInput').value = 'Bonjour depuis la visionneuse';
    document.getElementById('talkForm').requestSubmit();
  })()`);
  const heard = await until(() => ctx.state().chat.find((m) => m.from === 'peer'), 'host receives the chat line');
  check('chat_viewer_to_host', heard.text === 'Bonjour depuis la visionneuse', heard);
  check('chat_peer_name_shown', heard.name === 'test', heard.name);
  check(
    'chat_button_in_host_window',
    await until(async () => mainPage(`!document.getElementById('tabTalk').hidden && document.getElementById('talkBadge').textContent === '1'`), 'host chat button with a badge'),
  );
  await mainPage(`document.getElementById('tabTalk').click()`);
  check('chat_host_window_shows_line', await mainPage(`document.getElementById('talkLog').textContent.includes('Bonjour depuis la visionneuse')`));
  await mainPage(`(() => {
    document.getElementById('talkInput').value = 'Bien reçu, je regarde';
    document.getElementById('talkForm').requestSubmit();
  })()`);
  await until(async () => page(`document.getElementById('talkLog').textContent.includes('Bien reçu, je regarde')`), 'viewer receives the reply');
  check('chat_host_to_viewer', true);
  check(
    'chat_viewer_shows_both_sides',
    await page(`document.querySelectorAll('#talkLog .msg.me').length === 1 && document.querySelectorAll('#talkLog .msg.peer').length === 1`),
  );
  await mainPage(`document.getElementById('talkClose').click()`);

  // 8. ending from the host side tells the viewer, and the window is not left stuck. The case
  //    that used to freeze the window: the session ends while the viewer is full screen.
  win.show();
  await page(`document.getElementById('stage').requestFullscreen().then(() => true)`, true).catch(() => {});
  const wasFullscreen = await until(async () => page('Boolean(document.fullscreenElement)'), 'viewer full screen');
  check('viewer_was_full_screen', wasFullscreen);
  ctx.host.endSession();
  const ended = await until(async () => page(`!document.getElementById('stage').hidden === false`), 'viewer back to the card');
  check('host_can_end_session', ended);
  // the conversation is wiped with the session, on both sides
  check('chat_wiped_on_host', ctx.state().chat.length === 0, ctx.state().chat);
  check('chat_button_gone_on_host', await until(async () => mainPage(`document.getElementById('tabTalk').hidden && document.getElementById('talkLog').querySelectorAll('.msg').length === 0`), 'host chat cleared'));
  check('chat_wiped_in_viewer', await page(`document.getElementById('talkLog').querySelectorAll('.msg').length === 0 && document.getElementById('talkBtn').hidden`));
  const after = await page(`(() => ({
    status: document.getElementById('status').textContent,
    actions: !document.getElementById('endedActions').hidden,
    again: !document.getElementById('again').hidden,
    close: !document.getElementById('closeWin').hidden,
    countdown: document.getElementById('countdown').textContent,
    fullscreen: Boolean(document.fullscreenElement),
  }))()`);
  check('end_message_shown', /terminée par l.ordinateur distant/.test(after.status), after.status);
  check('end_offers_reconnect_and_close', after.actions && after.again && after.close, after);
  check('end_countdown_running', /ferme dans \d+ s/.test(after.countdown), after.countdown);
  check('end_not_left_fullscreen', after.fullscreen === false && win.isFullScreen() === false, { doc: after.fullscreen, win: win.isFullScreen() });
  // the close button must really close the window (it used to rely on window.close())
  await page(`document.getElementById('closeWin').click()`);
  await until(() => win.isDestroyed(), 'viewer window closed by its button');
  check('close_button_closes_window', win.isDestroyed());

  await relay.close();
  result.failed = Object.entries(result.checks).filter(([, v]) => !(v === true || v?.ok === true)).map(([k]) => k);
  result.error = result.failed.length ? `failed checks: ${result.failed.join(', ')}` : undefined;
  return result;
}

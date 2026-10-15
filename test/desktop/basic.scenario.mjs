// Smoke scenario for the desktop app: the control panel renders this PC's identity and status.
import fs from 'node:fs';
import path from 'node:path';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run(ctx) {
  const w = ctx.mainWindow;
  const read = (expr) => w.webContents.executeJavaScript(expr);

  // wait for the page to have rendered the state
  let id = '';
  for (let i = 0; i < 100 && !/^\d{3} \d{3} \d{3}$/.test(id); i++) {
    await sleep(100);
    try {
      id = await read("document.getElementById('myId')?.textContent ?? ''");
    } catch {
      /* page still loading */
    }
  }
  await sleep(1500); // let the relay connection attempt fail

  const page = await read(`(() => ({
    id: document.getElementById('myId').textContent,
    chip: document.getElementById('statusChip').textContent,
    chipClass: document.getElementById('statusChip').className,
    pwState: document.getElementById('pwState').textContent,
    server: document.getElementById('serverUrl').textContent,
    sessionBannerHidden: document.getElementById('sessionBanner').hidden,
    title: document.title,
    hasApi: typeof window.bifrost,
    nodeLeak: typeof require + '/' + typeof process,
  }))()`);

  // --- Heimdall settings, tabs, links (IPC checked through the real page) ---------------------
  const call = async (expr) => {
    try {
      return { ok: true, value: await read(`(async () => (${expr}))()`) };
    } catch (err) {
      return { ok: false, error: String(err.message ?? err) };
    }
  };
  const heimdall = {};
  heimdall.tabHiddenByDefault = await read("document.getElementById('tabHeimdall').hidden");
  heimdall.askWhileDisabled = await call("window.bifrost.askHeimdall('bonjour')");
  heimdall.badLink = await call("window.bifrost.openExternal('https://evil.example/')");
  await call("window.bifrost.setHeimdall({ enabled: true, provider: 'groq' })");
  await sleep(300);
  heimdall.tabShownWhenEnabled = !(await read("document.getElementById('tabHeimdall').hidden"));
  heimdall.noKeyNotice = !(await read("document.getElementById('heimdallNoKey').hidden"));
  heimdall.askWithoutKey = await call("window.bifrost.askHeimdall('bonjour')");
  await call("window.bifrost.setHeimdall({ apiKey: 'gsk_TESTKEY_0123456789' })");
  await sleep(300);
  heimdall.hasKeyAfterSave = ctx.state().heimdall.hasKey;
  heimdall.protectedKey = ctx.state().heimdall.keyProtected;
  const file = path.join(process.env.BIFROST_HOME, 'desktop.json');
  const raw = fs.readFileSync(file, 'utf8');
  heimdall.keyNotInPlainText = !raw.includes('gsk_TESTKEY_0123456789');
  heimdall.badKey = await call("window.bifrost.setHeimdall({ apiKey: 'has space' })");
  await call("window.bifrost.setHeimdall({ clearKey: true })");
  await sleep(300);
  heimdall.keyCleared = ctx.state().heimdall.hasKey === false;
  heimdall.tutorialVisible = !(await read("document.getElementById('tutorialGroq').hidden"));
  // the chat is a floating window: the page stays visible behind it
  await read("document.getElementById('tabHeimdall').click()");
  heimdall.chatOpens = !(await read("document.getElementById('panelHeimdall').hidden"));
  heimdall.homeStillVisible = !(await read("document.getElementById('panelHome').hidden"));
  heimdall.chatFloatsBottomRight = await read(
    "(() => { const r = document.getElementById('panelHeimdall').getBoundingClientRect(); return r.right > innerWidth - 40 && r.bottom < innerHeight - 100 && r.left > innerWidth * 0.3; })()",
  );
  heimdall.chatNoOverlapButton = await read(
    "(() => { const c = document.getElementById('panelHeimdall').getBoundingClientRect(); const b = document.getElementById('tabHeimdall').getBoundingClientRect(); return c.bottom <= b.top; })()",
  );
  await read("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
  heimdall.escapeCloses = await read("document.getElementById('panelHeimdall').hidden");
  await read("document.getElementById('tabSettings').click()");
  heimdall.settingsPanelShown = !(await read("document.getElementById('panelSettings').hidden"));
  heimdall.homeHiddenAfter = await read("document.getElementById('panelHome').hidden");

  const layout = {
    logoLoaded: await read("(() => { const i = document.querySelector('#railLogo img'); return i.complete && i.naturalWidth > 0; })()"),
    logoIsPng: (await read("document.querySelector('#railLogo img').getAttribute('src')")) === 'logo.png',
    // Heimdall and settings float at the bottom right of the window
    settingsBottomRight: await read(
      "(() => { const r = document.getElementById('tabSettings').getBoundingClientRect(); return r.right > innerWidth - 40 && r.bottom > innerHeight - 90; })()",
    ),
    heimdallBottomRight: await read(
      "(() => { const r = document.getElementById('tabHeimdall').getBoundingClientRect(); return r.right > innerWidth - 40 && r.bottom > innerHeight - 160; })()",
    ),
    // the icons sit exactly in the middle of their round buttons (offset in px)
    iconOffset: await read(
      "(() => { const o = {}; for (const id of ['tabSettings', 'tabHeimdall']) { const b = document.getElementById(id).getBoundingClientRect(); const v = document.querySelector('#' + id + ' svg').getBoundingClientRect(); o[id] = [Math.abs((v.x + v.width / 2) - (b.x + b.width / 2)), Math.abs((v.y + v.height / 2) - (b.y + b.height / 2)), b.width, b.height]; } return o; })()",
    ),
    effectOnlyOnLogo: await read("document.querySelectorAll('.bifrost').length <= 1 && !document.body.classList.contains('bifrost')"),
  };
  const update = {
    bannerHidden: await read("document.getElementById('updateBanner').hidden"),
    status: ctx.state().update.status,
  };
  return { page, state: ctx.state(), heimdall, layout, update };
}

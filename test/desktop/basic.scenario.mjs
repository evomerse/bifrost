// Smoke scenario for the desktop app: the control panel renders this PC's identity and status.
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
  return { page, state: ctx.state() };
}

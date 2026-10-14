// Bifrost desktop application (Electron main process).
//
// One program for both roles, like AnyDesk:
//   - this PC: shows its ID, keeps it reachable through the relay, asks the person in front of
//     it before letting anyone in (or accepts a password), shows a banner while shared;
//   - another PC: opens a viewer window (the very same viewer code as the website).
//
// The host logic is agent/host.js, shared with the command-line agent and the Windows service.

import { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, protocol, screen, session, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWindowsHelpers } from '../agent/helpers.js';
import { startHost } from '../agent/host.js';
import { buildPermissions } from '../agent/permissions.js';
import { clearPassword, configPath, ensureIdentity, loadConfig, normalizeServerUrl, saveConfig, setPassword } from '../agent/config.js';
import { formatId } from '../shared/auth.js';
import { VIEWER_FILES } from '../server/static-files.js';
import { createBifrostServer } from '../server/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = path.join(ROOT, 'desktop');
const TEST_SCENARIO = process.env.BIFROST_DESKTOP_TEST || '';
const TEST_MODE = Boolean(TEST_SCENARIO);
const DEBUG = process.env.BIFROST_DEBUG === '1';
const MIN_PASSWORD_LENGTH = 12;

// Pages of the control panel itself (not the remote viewer).
const UI_FILES = new Map(
  [
    ['/index.html', 'text/html; charset=utf-8'],
    ['/app.js', 'text/javascript; charset=utf-8'],
    ['/app.css', 'text/css; charset=utf-8'],
    ['/consent.html', 'text/html; charset=utf-8'],
    ['/consent.js', 'text/javascript; charset=utf-8'],
    ['/indicator.html', 'text/html; charset=utf-8'],
    ['/indicator.js', 'text/javascript; charset=utf-8'],
  ].map(([p, type]) => [p, [path.join('desktop', 'ui', p), type]]),
);

// Must be registered before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'bifrost', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// --- state ------------------------------------------------------------------------------------

const HOME = process.env.BIFROST_HOME || path.dirname(configPath());
// Chromium's profile (caches, local storage) lives in its own subfolder, next to agent.json.
app.setPath('userData', path.join(HOME, 'ui-data'));
const CFG_FILE = path.join(HOME, 'agent.json');
const SETTINGS_FILE = path.join(HOME, 'desktop.json');

let cfg = null;
let settings = { name: '', recent: [], minimizeToTray: true, runRelay: false, relayPort: 7780 };
let relay = null;
let relayError = '';
let host = null;
let hostStatus = 'connecting';
let sessionInfo = null; // { ip, phase: 'incoming' | 'active' }
let mainWindow = null;
let tray = null;
let quitting = false;

const log = (m) => {
  if (DEBUG || TEST_MODE) console.log(`${new Date().toISOString()} ${m}`);
};

function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    /* first run */
  }
}

function saveSettings() {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function uiState() {
  return {
    id: cfg.id,
    idFormatted: formatId(cfg.id),
    server: cfg.server,
    status: hostStatus,
    hasPassword: Boolean(cfg.passwordKey),
    requireConsent: Boolean(cfg.requireConsent),
    clipboard: cfg.clipboard !== false,
    fileTransfer: ['ask', 'allow', 'deny'].includes(cfg.fileTransfer) ? cfg.fileTransfer : 'ask',
    shares: (cfg.shares ?? []).map((s) => ({ name: s.name, dir: s.dir, write: Boolean(s.write) })),
    name: settings.name,
    recent: settings.recent,
    minimizeToTray: settings.minimizeToTray,
    autostart: TEST_MODE ? false : app.getLoginItemSettings().openAtLogin,
    session: sessionInfo,
    relay: { enabled: Boolean(settings.runRelay), running: Boolean(relay), port: settings.relayPort, error: relayError, addresses: relayAddresses() },
    version: app.getVersion(),
  };
}

/** Addresses other computers of the network can use to reach the relay running in this app. */
function relayAddresses() {
  if (!relay) return [];
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.family === 'IPv4' && !nic.internal) out.push(`ws://${nic.address}:${settings.relayPort}/ws`);
    }
  }
  return out;
}

/** Starts or stops the relay according to the settings. */
async function applyRelay() {
  if (relay) {
    const old = relay;
    relay = null;
    await old.close().catch(() => {});
  }
  relayError = '';
  if (!settings.runRelay) return;
  const candidate = createBifrostServer({
    port: settings.relayPort,
    host: '0.0.0.0',
    dataDir: path.join(HOME, 'relay'),
    log,
  });
  try {
    await candidate.listen();
    relay = candidate;
  } catch (err) {
    settings.runRelay = false;
    relayError = err.code === 'EADDRINUSE' ? `Le port ${settings.relayPort} est déjà utilisé.` : `Serveur non démarré : ${err.message}`;
  }
}

function pushState() {
  const s = uiState();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.__bifrostUi) w.webContents.send('state', s);
  }
  tray?.setToolTip(`Bifrost - ${s.idFormatted}${sessionInfo?.phase === 'active' ? ' (session en cours)' : ''}`);
}

function saveCfg() {
  saveConfig(cfg, CFG_FILE);
}

// --- windows: helpers ---------------------------------------------------------------------------

const ICON = nativeImage.createFromPath(path.join(DESKTOP, 'assets', 'icon.png'));

const webPreferences = (preload) => ({
  preload: path.join(DESKTOP, preload),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  devTools: DEBUG,
  backgroundThrottling: false,
});

const consentRequests = new Map(); // webContents id -> { title, text, timeoutMs, answer }
const indicatorData = new Map(); // webContents id -> { text, stopLabel, stop }
const viewerParams = new Map(); // webContents id -> { serverUrl, params }

/** The "someone wants to connect" dialog. Resolves true only on an explicit "Allow". */
function openConsent({ title, text, timeoutMs = 30_000 }) {
  let settle;
  const promise = new Promise((resolve) => (settle = resolve));
  const win = new BrowserWindow({
    width: 480,
    height: 430,
    title,
    icon: ICON,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    show: false,
    webPreferences: webPreferences('preload.cjs'),
  });
  win.setMenu(null);
  win.__bifrostUi = false;
  const id = win.webContents.id;
  consentRequests.set(id, {
    title,
    text,
    timeoutMs,
    answer: (yes) => {
      settle(Boolean(yes));
      if (!win.isDestroyed()) win.close();
    },
  });
  win.on('closed', () => {
    consentRequests.delete(id);
    settle(false); // closing the window is a refusal
  });
  win.once('ready-to-show', () => {
    win.show();
    win.moveTop();
    win.focus();
    win.flashFrame(true);
  });
  win.loadURL('bifrost://ui/consent.html');
  return {
    promise,
    cancel: () => {
      settle(false);
      if (!win.isDestroyed()) win.close();
    },
  };
}

/** The always-visible "your screen is shared" banner with a Stop button. */
function openIndicator({ text, stopLabel, onStop }) {
  const area = screen.getPrimaryDisplay().workArea;
  const width = 580;
  const win = new BrowserWindow({
    width,
    height: 46,
    x: Math.round(area.x + (area.width - width) / 2),
    y: area.y,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#b02020',
    webPreferences: webPreferences('preload.cjs'),
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.__bifrostUi = false;
  const id = win.webContents.id;
  indicatorData.set(id, { text, stopLabel, stop: onStop });
  win.on('closed', () => indicatorData.delete(id));
  win.once('ready-to-show', () => win.showInactive());
  win.loadURL('bifrost://ui/indicator.html');

  if (sessionInfo) {
    sessionInfo = { ...sessionInfo, phase: 'active' };
    pushState();
  }
  return {
    stop: () => {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}

function openViewer({ id, password = '', mode = 'control', label = '' }) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: `Bifrost - ${formatId(id)}`,
    icon: ICON,
    show: !TEST_MODE,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: webPreferences('preload-viewer.cjs'),
  });
  win.setMenu(null);
  win.__bifrostUi = false;
  const wcId = win.webContents.id;
  viewerParams.set(wcId, { serverUrl: cfg.server, params: { id, password, mode, label } });
  win.on('closed', () => viewerParams.delete(wcId));
  win.on('page-title-updated', (e) => e.preventDefault());
  win.loadURL('bifrost://app/');
  return win;
}

// --- the host -----------------------------------------------------------------------------------

function desktopHelpers() {
  // capture, input and clipboard come from the same Windows helpers as the CLI agent; the
  // consent dialog and the banner are native windows of this app.
  return { ...createWindowsHelpers(log), askConsent: openConsent, showIndicator: openIndicator };
}

function startHosting() {
  host?.stop();
  host = startHost({
    cfg,
    cfgFile: CFG_FILE,
    helpers: desktopHelpers(),
    log,
    onEvent: (e) => {
      if (e.type === 'status') hostStatus = e.status;
      if (e.type === 'session') sessionInfo = e.phase === 'incoming' ? { ip: e.ip, phase: 'incoming' } : null;
      if (e.type === 'session' && e.phase === 'incoming' && !TEST_MODE) showMainWindow();
      pushState();
    },
  });
}

// --- windows: main panel and tray ---------------------------------------------------------------

function createMainWindow({ hidden = false } = {}) {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 820,
    minHeight: 560,
    title: 'Bifrost',
    icon: ICON,
    show: false,
    autoHideMenuBar: true,
    webPreferences: webPreferences('preload.cjs'),
  });
  mainWindow.setMenu(null);
  mainWindow.__bifrostUi = true;
  mainWindow.once('ready-to-show', () => {
    if (!hidden && !TEST_MODE) mainWindow.show();
  });
  mainWindow.on('close', (e) => {
    if (!quitting && settings.minimizeToTray && !TEST_MODE) {
      e.preventDefault(); // keep hosting: the PC stays reachable from the tray
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => (mainWindow = null));
  mainWindow.loadURL('bifrost://ui/index.html');
}

function showMainWindow() {
  if (!mainWindow) createMainWindow();
  else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(DESKTOP, 'assets', 'tray.png')));
  tray.setToolTip('Bifrost');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Ouvrir Bifrost', click: showMainWindow },
      { type: 'separator' },
      {
        label: 'Quitter (ce PC ne sera plus joignable)',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', showMainWindow);
}

// --- IPC ---------------------------------------------------------------------------------------

const fromUi = (e) => e.senderFrame?.url?.startsWith('bifrost://ui/') === true;
const fromViewer = (e) => e.senderFrame?.url?.startsWith('bifrost://app/') === true;
const handle = (channel, fn) =>
  ipcMain.handle(channel, async (e, ...args) => {
    if (!fromUi(e)) throw new Error('forbidden');
    return fn(...args);
  });

function registerIpc() {
  handle('state:get', () => uiState());

  handle('password:set', async (password) => {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > 200) {
      throw new Error(`Mot de passe trop court (${MIN_PASSWORD_LENGTH} caractères minimum).`);
    }
    await setPassword(cfg, password);
    saveCfg();
    pushState();
  });
  handle('password:clear', () => {
    clearPassword(cfg);
    saveCfg();
    pushState();
  });

  handle('server:set', (url) => {
    if (typeof url !== 'string' || url.length > 300) throw new Error('Adresse non valide.');
    let normalized;
    try {
      normalized = normalizeServerUrl(url.trim());
      const u = new URL(normalized);
      if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error('protocole');
    } catch {
      throw new Error('Adresse non valide (exemple : wss://bifrost.exemple.fr).');
    }
    cfg.server = normalized;
    saveCfg();
    host?.reconnect();
    pushState();
  });

  handle('perm:set', (p) => {
    if (typeof p?.clipboard === 'boolean') cfg.clipboard = p.clipboard;
    if (['ask', 'allow', 'deny'].includes(p?.fileTransfer)) cfg.fileTransfer = p.fileTransfer;
    if (typeof p?.requireConsent === 'boolean') cfg.requireConsent = p.requireConsent;
    saveCfg();
    pushState();
  });

  handle('share:add', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Dossier à partager avec les personnes connectées',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return;
    const dir = r.filePaths[0];
    let name = path.basename(dir).replace(/[^\p{L}\p{N} ._-]/gu, '_').slice(0, 40) || 'Partage';
    if (['Inbox', 'Outbox'].includes(name)) name = `${name} (dossier)`;
    cfg.shares = [...(cfg.shares ?? []).filter((s) => s.name !== name), { name, dir, write: false }];
    saveCfg();
    pushState();
  });
  handle('share:remove', (name) => {
    cfg.shares = (cfg.shares ?? []).filter((s) => s.name !== name);
    saveCfg();
    pushState();
  });
  handle('share:write', ({ name, write }) => {
    cfg.shares = (cfg.shares ?? []).map((s) => (s.name === name ? { ...s, write: Boolean(write) } : s));
    saveCfg();
    pushState();
  });

  handle('settings:set', (s) => {
    if (typeof s?.name === 'string') settings.name = s.name.slice(0, 40);
    if (typeof s?.minimizeToTray === 'boolean') settings.minimizeToTray = s.minimizeToTray;
    if (typeof s?.autostart === 'boolean' && !TEST_MODE) {
      app.setLoginItemSettings({ openAtLogin: s.autostart, args: ['--hidden'] });
    }
    saveSettings();
    pushState();
  });

  handle('relay:set', async ({ enabled, port }) => {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('Port non valide (1024 à 65535).');
    settings.relayPort = p;
    settings.runRelay = Boolean(enabled);
    await applyRelay();
    if (relay) {
      // this PC then uses its own relay
      cfg.server = `ws://localhost:${settings.relayPort}/ws`;
      saveCfg();
      host?.reconnect();
    }
    saveSettings();
    pushState();
    if (relayError) throw new Error(relayError);
  });

  handle('connect', ({ id, password, mode, label }) => {
    const clean = String(id ?? '').replace(/\s+/g, '');
    if (!/^\d{9}$/.test(clean)) throw new Error("L'identifiant comporte 9 chiffres.");
    if (clean === cfg.id) throw new Error("C'est l'identifiant de cet ordinateur.");
    const who = String(label || settings.name || '').slice(0, 40);
    settings.recent = [clean, ...settings.recent.filter((r) => r !== clean)].slice(0, 6);
    saveSettings();
    pushState();
    openViewer({ id: clean, password: typeof password === 'string' ? password : '', mode: mode === 'view' ? 'view' : 'control', label: who });
  });

  handle('session:end', () => host?.endSession());
  handle('id:copy', () => clipboard.writeText(cfg.id));
  handle('transfers:open', async () => {
    const p = buildPermissions(cfg, { baseDir: HOME });
    p.ensureDirs();
    await shell.openPath(p.roots[0].dir.replace(/[\\/]Inbox$/, ''));
  });
  handle('app:quit', () => {
    quitting = true;
    app.quit();
  });

  // consent + indicator windows
  ipcMain.handle('consent:init', (e) => {
    const r = consentRequests.get(e.sender.id);
    return r ? { title: r.title, text: r.text, timeoutMs: r.timeoutMs } : null;
  });
  ipcMain.on('consent:answer', (e, yes) => consentRequests.get(e.sender.id)?.answer(yes === true));
  ipcMain.handle('indicator:init', (e) => {
    const r = indicatorData.get(e.sender.id);
    return r ? { text: r.text, stopLabel: r.stopLabel } : null;
  });
  ipcMain.on('indicator:stop', (e) => indicatorData.get(e.sender.id)?.stop());

  // viewer windows
  ipcMain.on('viewer:init', (e) => {
    const p = fromViewer(e) ? viewerParams.get(e.sender.id) : null;
    if (!p) {
      e.returnValue = null;
      return;
    }
    e.returnValue = { serverUrl: p.serverUrl, params: { ...p.params } };
    p.params.password = ''; // handed over once, never kept
  });
}

// --- protocol, permissions, navigation ----------------------------------------------------------

function registerProtocol() {
  const APP_CSP =
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' blob: data:; style-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
  const UI_CSP = "default-src 'self'; connect-src 'none'; img-src 'self' data:; style-src 'self'; base-uri 'none'; form-action 'none'";

  protocol.handle('bifrost', async (request) => {
    const u = new URL(request.url);
    const table = u.host === 'app' ? VIEWER_FILES : u.host === 'ui' ? UI_FILES : null;
    const entry = table?.get(u.pathname);
    if (!entry) return new Response('Not found', { status: 404 });
    try {
      const body = await fs.promises.readFile(path.join(ROOT, entry[0]));
      return new Response(body, {
        headers: {
          'content-type': entry[1],
          'content-security-policy': u.host === 'app' ? APP_CSP : UI_CSP,
          'cache-control': 'no-store',
        },
      });
    } catch {
      return new Response('Error', { status: 500 });
    }
  });

  const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);
  // Not URL.origin: for a custom scheme it is the opaque string "null".
  const trusted = (url) => {
    try {
      const u = new URL(url);
      return u.protocol === 'bifrost:' && u.host === 'app';
    } catch {
      return false;
    }
  };
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(allowed.has(permission) && trusted(details.requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => allowed.has(permission) && trusted(origin));
}

app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith('bifrost://')) e.preventDefault();
  });
});

// --- lifecycle ----------------------------------------------------------------------------------

if (!TEST_MODE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(async () => {
    loadSettings();
    cfg = loadConfig(CFG_FILE);
    await ensureIdentity(cfg);
    cfg.server ??= 'ws://localhost:7780/ws';
    saveCfg();

    registerProtocol();
    registerIpc();
    if (settings.runRelay && !TEST_MODE) await applyRelay();
    createMainWindow({ hidden: process.argv.includes('--hidden') });
    if (!TEST_MODE) createTray();
    startHosting();

    if (TEST_MODE) await runScenario();
  });

  app.on('window-all-closed', () => {
    // The app stays alive in the tray: this PC remains reachable.
    if (quitting || TEST_MODE) app.quit();
  });
  app.on('before-quit', () => {
    quitting = true;
    host?.stop();
    relay?.close().catch(() => {});
  });
}

/** Test hook: BIFROST_DESKTOP_TEST=<scenario.mjs> drives the real app and writes a result file. */
async function runScenario() {
  const out = process.env.BIFROST_DESKTOP_TEST_OUT;
  const watchdog = setTimeout(() => {
    if (out) fs.writeFileSync(out, JSON.stringify({ error: 'watchdog timeout' }));
    app.exit(2);
  }, Number(process.env.BIFROST_DESKTOP_TEST_TIMEOUT || 90_000));
  let result;
  try {
    const scenario = await import(pathToFileURL(TEST_SCENARIO).href);
    result = await scenario.run({
      app,
      BrowserWindow,
      state: uiState,
      get cfg() {
        return cfg;
      },
      get host() {
        return host;
      },
      get mainWindow() {
        return mainWindow;
      },
      openViewer,
      setRelay: async (enabled, port) => {
        settings.relayPort = port;
        settings.runRelay = enabled;
        await applyRelay();
        if (relay) {
          cfg.server = `ws://localhost:${port}/ws`;
          saveCfg();
          host?.reconnect();
        }
        pushState();
      },
      saveCfg,
      pushState,
      restartHosting: startHosting,
      viewerParams,
    });
  } catch (err) {
    result = { error: String(err?.stack ?? err) };
  }
  clearTimeout(watchdog);
  if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2));
  quitting = true;
  host?.stop();
  setTimeout(() => app.exit(result?.error ? 1 : 0), 300);
}

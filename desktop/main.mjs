// Bifrost desktop application (Electron main process).
//
// One program for both roles, like AnyDesk:
//   - this PC: shows its ID, keeps it reachable through the relay, asks the person in front of
//     it before letting anyone in (or accepts a password), shows a banner while shared;
//   - another PC: opens a viewer window (the very same viewer code as the website).
//
// The host logic is agent/host.js, shared with the command-line agent and the Windows service.

import electron, { app, BrowserWindow, Menu, Notification, Tray, clipboard, desktopCapturer, dialog, ipcMain, nativeImage, protocol, safeStorage, screen, session, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWindowsHelpers } from '../agent/helpers.js';
import { createPortableHelpers } from '../agent/helpers-portable.js';
import { createElectronCapture } from './capture-electron.mjs';
import { createHeimdall } from './heimdall/assistant.js';
import { EXTERNAL_LINKS, PROVIDERS, providerInfo } from './heimdall/providers.js';
import { createSecretStore } from './heimdall/secrets.js';
import { Updater } from './updater.mjs';
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
    ['/capture.html', 'text/html; charset=utf-8'],
    ['/capture.js', 'text/javascript; charset=utf-8'],
    ['/logo.png', 'image/png'],
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
let settings = {
  name: '',
  recent: [],
  minimizeToTray: true,
  runRelay: false,
  relayPort: 7780,
  autoUpdate: true,
  heimdall: { enabled: false, provider: 'groq', model: '', keys: {} },
};
// Windows keeps its native helpers; macOS and Linux (or BIFROST_PORTABLE=1) use Electron's capture.
const PORTABLE = process.platform !== 'win32' || process.env.BIFROST_PORTABLE === '1';
const secrets = createSecretStore(safeStorage);
let update = { status: 'idle', version: '', notes: '', progress: 0, error: '', canInstall: false, pageUrl: '', checkedAt: 0 };
let updater = null;
let relay = null;
let relayError = '';
let host = null;
let hostStatus = 'connecting';
let sessionInfo = null; // { ip, phase: 'incoming' | 'active' }
// Chat with the person connected to this PC. Memory only, emptied whenever a session starts or
// ends: nothing of a conversation survives its session.
const MAX_CHAT_MESSAGES = 200;
let chatMessages = []; // { from: 'me' | 'peer', text, name?, ts }
let mainWindow = null;
let tray = null;
let quitting = false;

const log = (m) => {
  if (DEBUG || TEST_MODE) console.log(`${new Date().toISOString()} ${m}`);
};

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    settings = { ...settings, ...saved, heimdall: { ...settings.heimdall, ...(saved.heimdall ?? {}) } };
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
    autostart: TEST_MODE ? false : getAutostart(),
    session: sessionInfo,
    chat: chatMessages,
    relay: { enabled: Boolean(settings.runRelay), running: Boolean(relay), port: settings.relayPort, error: relayError, addresses: relayAddresses() },
    version: app.getVersion(),
    platform: process.platform,
    autoUpdate: settings.autoUpdate,
    update,
    heimdall: heimdallState(),
  };
}

function heimdallState() {
  const h = settings.heimdall;
  const p = providerInfo(h.provider);
  return {
    enabled: Boolean(h.enabled),
    provider: p.id,
    model: h.model || '',
    defaultModel: p.defaultModel,
    noKey: Boolean(p.noKey),
    hasKey: Boolean(p.noKey) || Boolean(secrets.open(h.keys?.[p.id])),
    keyProtected: secrets.encrypted,
    providers: Object.values(PROVIDERS).map(({ id, label, defaultModel, keyUrl, noKey }) => ({ id, label, defaultModel, keyUrl, noKey: Boolean(noKey) })),
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

/** Login item: native on Windows and macOS; an XDG autostart entry on Linux. */
const linuxAutostartFile = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'bifrost.desktop');

function getAutostart() {
  if (process.platform === 'linux') return fs.existsSync(linuxAutostartFile());
  return app.getLoginItemSettings().openAtLogin;
}

function setAutostart(on) {
  if (process.platform === 'linux') {
    const file = linuxAutostartFile();
    if (!on) return fs.rmSync(file, { force: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const exec = process.execPath.replace(/"/g, '\\"');
    return fs.writeFileSync(
      file,
      `[Desktop Entry]
Type=Application
Name=Bifrost
Exec="${exec}" --hidden
X-GNOME-Autostart-enabled=true
`,
    );
  }
  return app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
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
  // Windows: capture, input and clipboard come from the same helpers as the CLI agent.
  // macOS / Linux: Electron's own capture and clipboard, xdotool / osascript for input.
  // The consent dialog and the banner are native windows of this app on every platform.
  const base = PORTABLE
    ? createPortableHelpers({
        log,
        clipboard,
        capture: createElectronCapture({ electron: { BrowserWindow, desktopCapturer, screen, ipcMain, session }, desktopDir: DESKTOP, log }),
      })
    : createWindowsHelpers(log);
  return { ...base, askConsent: openConsent, showIndicator: openIndicator };
}

// --- Heimdall (assistant) -----------------------------------------------------------------------

async function confirmAction(text) {
  const opts = {
    type: 'question',
    buttons: ['Refuser', 'Autoriser'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Heimdall',
    message: 'Heimdall demande l’autorisation d’agir sur cet ordinateur',
    detail: text,
  };
  const r = mainWindow && !mainWindow.isDestroyed() ? await dialog.showMessageBox(mainWindow, opts) : await dialog.showMessageBox(opts);
  return r.response === 1;
}

const heimdall = createHeimdall({
  getConfig: () => {
    const h = settings.heimdall;
    const p = providerInfo(h.provider);
    return { provider: p.id, model: h.model || p.defaultModel, apiKey: secrets.open(h.keys?.[p.id]) };
  },
  confirm: confirmAction,
  log,
});

// --- updates ------------------------------------------------------------------------------------

function createUpdater() {
  let installDir = null;
  if (app.isPackaged && !TEST_MODE) {
    installDir = process.platform === 'darwin' ? path.resolve(process.execPath, '..', '..', '..') : path.dirname(process.execPath);
  }
  return new Updater({
    currentVersion: app.getVersion(),
    repo: process.env.BIFROST_UPDATE_REPO || undefined,
    installDir,
    exePath: process.execPath,
    log,
  });
}

async function checkForUpdate({ manual = false } = {}) {
  if (update.status === 'downloading' || update.status === 'installing') return;
  update = { ...update, status: 'checking', error: '' };
  pushState();
  try {
    const r = await updater.check();
    update = {
      ...update,
      status: r.available ? 'available' : 'none',
      version: r.version,
      notes: r.notes ?? '',
      pageUrl: r.pageUrl ?? '',
      canInstall: Boolean(r.canInstall),
      checkedAt: Date.now(),
      error: '',
    };
  } catch (err) {
    // A silent background check must not nag; a manual one reports the problem.
    update = { ...update, status: manual ? 'error' : 'idle', error: manual ? String(err.message ?? err) : '' };
  }
  pushState();
  if (update.status === 'available') tray?.setToolTip(`Bifrost - mise à jour ${update.version} disponible`);
}

function receiveChat({ text, name }) {
  if (typeof text !== 'string' || !text) return;
  chatMessages = [...chatMessages, { from: 'peer', text, name: typeof name === 'string' ? name : '', ts: Date.now() }].slice(-MAX_CHAT_MESSAGES);
  if (TEST_MODE || !Notification.isSupported()) return;
  // Someone typed while this window is hidden or in the background: say so, without stealing focus.
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isFocused()) {
    const note = new Notification({ title: name ? `Bifrost - ${name}` : 'Bifrost - message', body: text.slice(0, 200) });
    note.on('click', showMainWindow);
    note.show();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(true);
  }
}

function startHosting() {
  host?.stop();
  host = startHost({
    cfg,
    cfgFile: CFG_FILE,
    helpers: desktopHelpers(),
    log,
    chat: true,
    onEvent: (e) => {
      if (e.type === 'status') hostStatus = e.status;
      if (e.type === 'session') {
        sessionInfo = e.phase === 'incoming' ? { ip: e.ip, phase: 'incoming' } : null;
        chatMessages = []; // a new session, or the end of one: the conversation is gone
      }
      if (e.type === 'chat') receiveChat(e);
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
      { label: 'Rechercher une mise à jour', click: () => checkForUpdate({ manual: true }) },
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
    if (typeof s?.autostart === 'boolean' && !TEST_MODE) setAutostart(s.autostart);
    if (typeof s?.autoUpdate === 'boolean') settings.autoUpdate = s.autoUpdate;
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

  handle('update:check', () => checkForUpdate({ manual: true }));
  handle('update:install', async () => {
    if (update.status !== 'available' || !update.canInstall) throw new Error('Aucune mise à jour installable.');
    update = { ...update, status: 'downloading', progress: 0, error: '' };
    pushState();
    let last = 0;
    try {
      await updater.install((p) => {
        if (Date.now() - last > 250) {
          last = Date.now();
          update = { ...update, progress: p };
          pushState();
        }
      });
    } catch (err) {
      update = { ...update, status: 'error', error: String(err.message ?? err) };
      pushState();
      throw err;
    }
    update = { ...update, status: 'installing', progress: 1 };
    pushState();
    // the swap script waits for this process to exit, replaces the folder and starts it again
    setTimeout(() => {
      quitting = true;
      app.quit();
    }, 600);
  });

  handle('heimdall:set', (h) => {
    const cur = settings.heimdall;
    if (typeof h?.enabled === 'boolean') cur.enabled = h.enabled;
    if (typeof h?.provider === 'string' && Object.hasOwn(PROVIDERS, h.provider)) cur.provider = h.provider;
    if (typeof h?.model === 'string') cur.model = h.model.trim().slice(0, 80);
    if (typeof h?.apiKey === 'string' && h.apiKey.trim()) {
      const key = h.apiKey.trim();
      if (key.length > 400 || /\s/.test(key)) throw new Error('Clé API non valide.');
      cur.keys = { ...(cur.keys ?? {}), [cur.provider]: secrets.seal(key) };
    }
    if (h?.clearKey === true) {
      const { [cur.provider]: _gone, ...rest } = cur.keys ?? {};
      cur.keys = rest;
    }
    heimdall.reset();
    saveSettings();
    pushState();
  });
  handle('heimdall:ask', async (text) => {
    if (!settings.heimdall.enabled) throw new Error('Heimdall est désactivé (Paramètres).');
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new Error('Message non valide.');
    return heimdall.ask(text.trim());
  });
  handle('heimdall:reset', () => heimdall.reset());
  handle('external:open', async (url) => {
    if (typeof url !== 'string' || !EXTERNAL_LINKS.has(url)) throw new Error('Adresse non autorisée.');
    await shell.openExternal(url);
  });
  handle('update:page', async () => {
    const u = update.pageUrl;
    if (typeof u === 'string' && u.startsWith('https://github.com/')) await shell.openExternal(u);
  });

  handle('session:end', () => host?.endSession());
  handle('chat:send', (text) => {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('Message vide ou trop long.');
    if (!host?.sendChat(text)) throw new Error('Aucune session en cours : le message n’a pas été envoyé.');
    chatMessages = [...chatMessages, { from: 'me', text: text.trim(), ts: Date.now() }].slice(-MAX_CHAT_MESSAGES);
    pushState();
  });
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
  ipcMain.on('viewer:close', (e) => {
    if (fromViewer(e)) BrowserWindow.fromWebContents(e.sender)?.destroy();
  });
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
  const capturePage = (url) => url === 'bifrost://ui/capture.html';
  const captureAllowed = new Set(['media', 'display-capture']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback((allowed.has(permission) && trusted(details.requestingUrl)) || (captureAllowed.has(permission) && capturePage(details.requestingUrl)));
  });
  session.defaultSession.setPermissionCheckHandler(
    (_wc, permission, origin, details) =>
      (allowed.has(permission) && trusted(origin)) || (captureAllowed.has(permission) && capturePage(details?.requestingUrl ?? origin)),
  );
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
  app.on('activate', () => showMainWindow()); // macOS: click on the Dock icon

  app.whenReady().then(async () => {
    loadSettings();
    cfg = loadConfig(CFG_FILE);
    await ensureIdentity(cfg);
    cfg.server ??= 'ws://localhost:7780/ws';
    saveCfg();

    registerProtocol();
    registerIpc();
    updater = createUpdater();
    if (settings.runRelay && !TEST_MODE) await applyRelay();
    createMainWindow({ hidden: process.argv.includes('--hidden') });
    if (!TEST_MODE) createTray();
    startHosting();

    if (!TEST_MODE) {
      // look for a new release shortly after start, then every 6 hours
      const auto = () => settings.autoUpdate && checkForUpdate();
      setTimeout(auto, 20_000).unref();
      setInterval(auto, 6 * 60 * 60 * 1000).unref();
    }

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

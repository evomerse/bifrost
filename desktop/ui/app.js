// Control panel of the desktop app. All state lives in the main process; this page renders it
// and sends a few validated commands back through window.bifrost (see preload.cjs).
const api = window.bifrost;
const $ = (id) => document.getElementById(id);

const STATUS = {
  online: ['En ligne : joignable', 'online'],
  connecting: ['Connexion au serveur…', 'connecting'],
  offline: ['Serveur injoignable', 'offline'],
};

const AUTOSTART_LABEL = {
  win32: 'Démarrer Bifrost avec Windows',
  darwin: 'Ouvrir Bifrost à l’ouverture de session',
  linux: 'Démarrer Bifrost à l’ouverture de session',
};

function show(el, text) {
  el.textContent = text ?? '';
  el.hidden = !text;
}

const cleanError = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

async function guarded(errorEl, fn) {
  try {
    show(errorEl, '');
    await fn();
    return true;
  } catch (err) {
    // Electron prefixes IPC errors; keep only our message.
    show(errorEl, cleanError(err));
    return false;
  }
}

// --- tabs -------------------------------------------------------------------------------------
const TABS = ['home', 'settings'];
const panelOf = (name) => $(`panel${name[0].toUpperCase()}${name.slice(1)}`);
let currentTab = 'home';

function selectTab(name) {
  if (!TABS.includes(name)) return;
  currentTab = name;
  for (const t of TABS) {
    const on = t === name;
    panelOf(t).hidden = !on;
    const btn = document.querySelector(`[data-tab="${t}"]`);
    btn.setAttribute(btn.getAttribute('role') === 'tab' ? 'aria-selected' : 'aria-pressed', String(on));
  }
}
// A second click on the settings button goes back to the home page.
for (const b of document.querySelectorAll('[data-tab]')) {
  b.addEventListener('click', () => selectTab(b.dataset.tab !== 'home' && currentTab === b.dataset.tab ? 'home' : b.dataset.tab));
}

// The two chats (Heimdall, and the person connected) are floating windows: they never replace the
// page behind them, and only one is open at a time.
const POPUPS = {
  heimdall: { button: 'tabHeimdall', panel: 'panelHeimdall', input: 'chatInput', usable: () => Boolean(current?.heimdall.enabled) },
  talk: { button: 'tabTalk', panel: 'panelTalk', input: 'talkInput', usable: () => current?.session?.phase === 'active' },
};
function setPopup(name, open) {
  for (const [key, p] of Object.entries(POPUPS)) {
    if (key !== name && !open) continue; // closing one window leaves the other alone
    const on = key === name && open && p.usable();
    $(p.panel).hidden = !on;
    $(p.button).setAttribute('aria-expanded', String(on));
    if (on) $(p.input).focus();
  }
  if (name === 'talk' && !$('panelTalk').hidden) markTalkSeen();
}
for (const [name, p] of Object.entries(POPUPS)) {
  $(p.button).addEventListener('click', () => setPopup(name, $(p.panel).hidden));
}
$('heimdallClose').addEventListener('click', () => {
  setPopup('heimdall', false);
  $('tabHeimdall').focus();
});
$('talkClose').addEventListener('click', () => {
  setPopup('talk', false);
  $('tabTalk').focus();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const [name, p] of Object.entries(POPUPS)) if (!$(p.panel).hidden) setPopup(name, false);
});

// The Bifrost light: only the logo plays it, when a connection is made (either way).
let bifrostTimer = null;
function playBifrost() {
  const logo = $('railLogo');
  logo.classList.remove('bifrost');
  void logo.offsetWidth; // restart the animation
  logo.classList.add('bifrost');
  clearTimeout(bifrostTimer);
  bifrostTimer = setTimeout(() => logo.classList.remove('bifrost'), 2100);
}
let wasActive = false;

// --- render -----------------------------------------------------------------------------------
let current = null;

function renderUpdate(s) {
  const u = s.update;
  const banner = $('updateBanner');
  const visible = ['available', 'downloading', 'installing'].includes(u.status);
  banner.hidden = !visible;
  if (visible) {
    $('updateText').textContent =
      u.status === 'available'
        ? `Une nouvelle version de Bifrost est disponible : ${u.version} (vous avez ${s.version}).`
        : u.status === 'downloading'
          ? `Téléchargement de la version ${u.version}… ${Math.round(u.progress * 100)} %`
          : 'Installation : Bifrost va redémarrer…';
    $('updateInstall').hidden = !(u.status === 'available' && u.canInstall);
    $('updateProgress').hidden = u.status === 'available';
    $('updateProgress').value = u.progress;
    $('updatePage').hidden = u.status !== 'available';
    $('updatePage').textContent = u.canInstall ? 'Voir les nouveautés' : 'Télécharger depuis GitHub';
  }
  const state =
    u.status === 'checking'
      ? 'Recherche en cours…'
      : u.status === 'none'
        ? `Vous avez la dernière version (${s.version}).`
        : u.status === 'available'
          ? `Version ${u.version} disponible.`
          : '';
  $('updateState').textContent = state;
  $('updateCheck').disabled = u.status === 'checking' || u.status === 'downloading' || u.status === 'installing';
  show($('updateError'), u.status === 'error' ? u.error : '');
}

function renderHeimdall(s) {
  const h = s.heimdall;
  $('tabHeimdall').hidden = !h.enabled;
  if (!h.enabled) setPopup('heimdall', false);
  $('heimdallEnabled').checked = h.enabled;
  $('heimdallConfig').hidden = !h.enabled;
  $('heimdallNoKey').hidden = h.hasKey;

  const sel = $('heimdallProvider');
  if (sel.options.length !== h.providers.length) {
    sel.replaceChildren(
      ...h.providers.map((p) => {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.label;
        return o;
      }),
    );
  }
  sel.value = h.provider;
  if (document.activeElement !== $('heimdallModel')) $('heimdallModel').value = h.model;
  $('heimdallModel').placeholder = h.defaultModel || 'défini par Claude Code';
  $('heimdallDefaultModel').textContent = h.defaultModel || '—';

  $('heimdallKeyForm').hidden = h.noKey;
  $('heimdallKeyClear').hidden = !h.hasKey || h.noKey;
  $('heimdallKeyState').textContent = h.noKey
    ? 'Ce fournisseur n’utilise pas de clé API.'
    : h.hasKey
      ? `Une clé est enregistrée${h.keyProtected ? ' (chiffrée par le coffre du système).' : ' (en clair : aucun coffre du système disponible sur ce PC).'}`
      : 'Aucune clé enregistrée pour ce fournisseur.';
  $('tutorialGroq').hidden = h.provider !== 'groq';
  $('tutorialCode').hidden = h.provider !== 'claude-code';
  $('tutorialOther').hidden = h.provider === 'groq' || h.provider === 'claude-code';
}

function render(s) {
  current = s;
  renderTalk(s);
  const [label, cls] = STATUS[s.status] ?? STATUS.connecting;
  const chip = $('statusChip');
  chip.textContent = label;
  chip.className = `chip ${cls}`;

  $('myId').textContent = s.idFormatted;
  $('serverUrl').textContent = s.server;
  $('version').textContent = s.version;
  $('autostartLabel').textContent = AUTOSTART_LABEL[s.platform] ?? AUTOSTART_LABEL.linux;

  const isActive = s.session?.phase === 'active';
  if (isActive && !wasActive) playBifrost(); // someone just joined this computer
  wasActive = isActive;

  const banner = $('sessionBanner');
  banner.hidden = !s.session;
  if (s.session) {
    $('sessionText').textContent =
      s.session.phase === 'active'
        ? `Quelqu'un voit cet ordinateur (${s.session.ip}).`
        : `Demande de connexion depuis ${s.session.ip}…`;
  }

  $('pwState').textContent = s.hasPassword
    ? 'Un mot de passe est défini : une personne qui le connaît peut se connecter sans que vous ayez à accepter.'
    : 'Aucun mot de passe : chaque connexion demande votre accord. Sans mot de passe, personne ne peut se connecter quand vous êtes absent.';
  $('pwClear').hidden = !s.hasPassword;
  $('requireConsent').checked = s.requireConsent;
  $('requireConsent').disabled = !s.hasPassword;

  $('clipboard').checked = s.clipboard;
  $('fileTransfer').value = s.fileTransfer;

  const shares = $('shares');
  shares.replaceChildren();
  for (const sh of s.shares) {
    const li = document.createElement('li');
    const info = document.createElement('span');
    info.className = 'grow';
    const name = document.createElement('strong');
    name.textContent = sh.name;
    const path = document.createElement('div');
    path.className = 'path';
    path.textContent = sh.dir;
    info.append(name, path);

    const write = document.createElement('label');
    write.className = 'check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = sh.write;
    box.addEventListener('change', () => api.setShareWrite(sh.name, box.checked));
    write.append(box, document.createTextNode(' dépôt autorisé'));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Retirer';
    remove.addEventListener('click', () => api.removeShare(sh.name));
    li.append(info, write, remove);
    shares.append(li);
  }

  const recent = $('recent');
  recent.replaceChildren();
  $('noRecent').hidden = s.recent.length > 0;
  for (const id of s.recent) {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = id.replace(/(\d{3})(?=\d)/g, '$1 ');
    const use = document.createElement('button');
    use.type = 'button';
    use.textContent = 'Utiliser';
    use.addEventListener('click', () => {
      $('remoteId').value = id;
      $('remotePassword').focus();
    });
    li.append(text, use);
    recent.append(li);
  }

  if (document.activeElement !== $('nameInput')) $('nameInput').value = s.name;
  if (document.activeElement !== $('serverInput')) $('serverInput').value = s.server;
  $('relayEnabled').checked = s.relay.enabled && s.relay.running;
  if (document.activeElement !== $('relayPort')) $('relayPort').value = s.relay.port;
  const addresses = $('relayAddresses');
  addresses.replaceChildren();
  for (const a of s.relay.addresses) {
    const li = document.createElement('li');
    const text = document.createElement('code');
    text.textContent = a;
    li.append(text);
    addresses.append(li);
  }
  $('autostart').checked = s.autostart;
  $('tray').checked = s.minimizeToTray;
  $('autoUpdate').checked = s.autoUpdate;

  renderUpdate(s);
  renderHeimdall(s);
}

// --- this computer ---------------------------------------------------------------------------

$('copyId').addEventListener('click', async () => {
  await api.copyId();
  const b = $('copyId');
  b.textContent = 'Copié';
  setTimeout(() => (b.textContent = 'Copier'), 1200);
});
$('endSession').addEventListener('click', () => api.endSession());

$('pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ok = await guarded($('pwError'), () => api.setPassword($('pwInput').value));
  if (ok) $('pwInput').value = '';
});
$('pwClear').addEventListener('click', () => guarded($('pwError'), () => api.clearPassword()));
$('requireConsent').addEventListener('change', (e) => api.setPermissions({ requireConsent: e.target.checked }));
$('clipboard').addEventListener('change', (e) => api.setPermissions({ clipboard: e.target.checked }));
$('fileTransfer').addEventListener('change', (e) => api.setPermissions({ fileTransfer: e.target.value }));
$('addShare').addEventListener('click', () => api.addShare());
$('openTransfers').addEventListener('click', () => api.openTransfers());

// --- another computer ------------------------------------------------------------------------

$('connectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const ok = await guarded($('connectError'), () =>
    api.connect({
      id: $('remoteId').value,
      password: $('remotePassword').value,
      mode: form.elements.mode.value,
    }),
  );
  if (ok) {
    $('remotePassword').value = '';
    playBifrost(); // this computer is joining another one
  }
});

// --- settings --------------------------------------------------------------------------------

$('serverForm').addEventListener('submit', (e) => {
  e.preventDefault();
  guarded($('serverError'), () => api.setServer($('serverInput').value));
});
$('relayForm').addEventListener('submit', (e) => {
  e.preventDefault();
  guarded($('relayError'), () => api.setRelay($('relayEnabled').checked, Number($('relayPort').value)));
});
$('nameInput').addEventListener('change', (e) => api.setSettings({ name: e.target.value }));
$('autostart').addEventListener('change', (e) => api.setSettings({ autostart: e.target.checked }));
$('tray').addEventListener('change', (e) => api.setSettings({ minimizeToTray: e.target.checked }));
$('autoUpdate').addEventListener('change', (e) => api.setSettings({ autoUpdate: e.target.checked }));
$('quit').addEventListener('click', () => api.quit());

// --- updates ---------------------------------------------------------------------------------

$('updateCheck').addEventListener('click', () => guarded($('updateError'), () => api.checkUpdate()));
$('updateInstall').addEventListener('click', () => guarded($('updateError'), () => api.installUpdate()));
$('updatePage').addEventListener('click', () => api.openUpdatePage());

// --- Heimdall --------------------------------------------------------------------------------

const heimdall = (patch) => guarded($('heimdallError'), () => api.setHeimdall(patch));
$('heimdallEnabled').addEventListener('change', (e) => heimdall({ enabled: e.target.checked }));
$('heimdallProvider').addEventListener('change', (e) => heimdall({ provider: e.target.value }));
$('heimdallModel').addEventListener('change', (e) => heimdall({ model: e.target.value }));
$('heimdallKeyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ok = await heimdall({ apiKey: $('heimdallKey').value });
  if (ok) $('heimdallKey').value = '';
});
$('heimdallKeyClear').addEventListener('click', () => heimdall({ clearKey: true }));
$('openGroq').addEventListener('click', () => api.openExternal('https://console.groq.com/keys'));
$('openProviderKey').addEventListener('click', () => {
  const p = current?.heimdall.providers.find((x) => x.id === current.heimdall.provider);
  if (p) api.openExternal(p.keyUrl);
});

const chatLog = $('chatLog');
let chatBusy = false;

function addMessage(kind, text, extra = '') {
  const div = document.createElement('div');
  div.className = `msg ${kind} ${extra}`.trim();
  div.textContent = text;
  chatLog.append(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}

function addStep(step) {
  const div = document.createElement('div');
  div.className = `step ${step.status === 'done' ? '' : step.status}`.trim();
  const title = document.createElement('div');
  const arg = step.args?.command ? ` : ${step.args.command}` : '';
  title.textContent = `${step.status === 'denied' ? '⛔' : step.status === 'error' ? '⚠️' : '⚙️'} ${step.name}${arg}`;
  div.append(title);
  if (step.output) {
    const pre = document.createElement('pre');
    pre.textContent = step.output;
    div.append(pre);
  }
  chatLog.append(div);
}

$('chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text || chatBusy) return;
  chatBusy = true;
  $('chatInput').value = '';
  $('chatSend').disabled = true;
  show($('chatError'), '');
  if (chatLog.querySelector('p.muted')) chatLog.replaceChildren();
  addMessage('user', text);
  const pending = addMessage('bot', 'Heimdall réfléchit…', 'pending');
  try {
    const r = await api.askHeimdall(text);
    pending.remove();
    for (const step of r.steps) addStep(step);
    addMessage('bot', r.reply);
  } catch (err) {
    pending.remove();
    show($('chatError'), cleanError(err));
  } finally {
    chatBusy = false;
    $('chatSend').disabled = false;
    $('chatInput').focus();
    chatLog.scrollTop = chatLog.scrollHeight;
  }
});
$('heimdallReset').addEventListener('click', async () => {
  await api.resetHeimdall();
  chatLog.replaceChildren();
  show($('chatError'), '');
});

// --- chat with the person connected ------------------------------------------------------------
const talkLog = $('talkLog');
let talkRendered = 0; // messages already drawn
let talkSeen = 0; // messages the user has had on screen

function markTalkSeen() {
  talkSeen = current?.chat?.length ?? 0;
  renderTalkBadge();
}

function renderTalkBadge() {
  const list = current?.chat ?? [];
  const unread = $('panelTalk').hidden ? list.slice(talkSeen).filter((m) => m.from === 'peer').length : 0;
  $('talkBadge').hidden = unread === 0;
  $('talkBadge').textContent = unread > 9 ? '9+' : String(unread);
}

function renderTalk(s) {
  const active = s.session?.phase === 'active';
  $('tabTalk').hidden = !active;
  document.body.classList.toggle('has-talk', active);
  const list = Array.isArray(s.chat) ? s.chat : [];
  if (!active) {
    setPopup('talk', false);
    if (talkRendered) {
      talkLog.replaceChildren();
      talkRendered = 0;
    }
    talkSeen = 0;
    renderTalkBadge();
    return;
  }
  if (list.length < talkRendered) {
    talkLog.replaceChildren(); // a new session: start from nothing
    talkRendered = 0;
    talkSeen = 0;
  }
  if (list.length === 0) {
    if (!talkLog.querySelector('p.muted')) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'Aucun message pour l’instant.';
      talkLog.replaceChildren(p);
    }
  } else {
    if (talkRendered === 0) talkLog.replaceChildren();
    for (const m of list.slice(talkRendered)) {
      const div = document.createElement('div');
      div.className = `msg ${m.from === 'me' ? 'user' : 'peer'}`;
      div.textContent = m.text;
      talkLog.append(div);
    }
    talkRendered = list.length;
    talkLog.scrollTop = talkLog.scrollHeight;
  }
  const who = [...list].reverse().find((m) => m.from === 'peer' && m.name)?.name || s.session.ip;
  $('talkTitle').textContent = who ? `Discussion avec ${who}` : 'Discussion';
  if (!$('panelTalk').hidden) talkSeen = list.length;
  renderTalkBadge();
}

$('talkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('talkInput').value.trim();
  if (!text) return;
  show($('talkError'), '');
  try {
    await api.sendChat(text);
    $('talkInput').value = '';
  } catch (err) {
    show($('talkError'), cleanError(err));
  }
  $('talkInput').focus();
});

api.onState(render);
api.getState().then(render);

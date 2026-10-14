// Control panel of the desktop app. All state lives in the main process; this page renders it
// and sends a few validated commands back through window.bifrost (see preload.cjs).
const api = window.bifrost;
const $ = (id) => document.getElementById(id);

const STATUS = {
  online: ['En ligne : joignable', 'online'],
  connecting: ['Connexion au serveur…', 'connecting'],
  offline: ['Serveur injoignable', 'offline'],
};

function show(el, text) {
  el.textContent = text ?? '';
  el.hidden = !text;
}

async function guarded(errorEl, fn) {
  try {
    show(errorEl, '');
    await fn();
    return true;
  } catch (err) {
    // Electron prefixes IPC errors; keep only our message.
    show(errorEl, String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    return false;
  }
}

let current = null;

function render(s) {
  current = s;
  const [label, cls] = STATUS[s.status] ?? STATUS.connecting;
  const chip = $('statusChip');
  chip.textContent = label;
  chip.className = `chip ${cls}`;

  $('myId').textContent = s.idFormatted;
  $('serverUrl').textContent = s.server;
  $('version').textContent = s.version;

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
  if (ok) $('remotePassword').value = '';
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
$('quit').addEventListener('click', () => api.quit());

api.onState(render);
api.getState().then(render);

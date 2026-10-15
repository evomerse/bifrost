// Clipboard bridge and file-transfer panel of the viewer (browser only: it touches the DOM).
// The wire logic lives in transfer.js; this file is the user interface around it.

import { TransferClient, TransferError } from '/transfer.js';

const BLOB_FALLBACK_LIMIT = 1024 ** 3; // without the File System Access API the file sits in memory

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} Ko`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
  return `${(bytes / 1024 ** 3).toFixed(2)} Go`;
}

function readPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* storage blocked */
  }
}

/**
 * Created once. start(io) binds it to a session, stop() unbinds it.
 *   io = { sendJson(obj), sendChunk(id, last, bytes), bufferedAmount() }
 */
export function createExtras($) {
  const el = {
    clipBtn: $('clipBtn'),
    clipPending: $('clipPending'),
    filesBtn: $('filesBtn'),
    panel: $('files'),
    close: $('filesClose'),
    crumb: $('crumb'),
    entries: $('entries'),
    transferList: $('transferList'),
    hint: $('filesHint'),
    upload: $('upload'),
    uploadLabel: $('uploadLabel'),
    stage: $('stage'),
    dropHint: $('dropHint'),
  };

  let io = null;
  let transfers = null;
  let perms = { clipboard: false, files: 'deny', roots: [] };
  let clipSync = readPref('bifrost.clip', true);
  let pendingClip = null;
  let dir = '/';

  const canFiles = () => Boolean(io) && perms.files !== 'deny' && perms.roots.length > 0;
  const writableRoot = () => perms.roots.find((r) => r.write) ?? null;

  // --- clipboard ---------------------------------------------------------------------------

  function renderClipButton() {
    el.clipBtn.hidden = !perms.clipboard;
    el.clipBtn.setAttribute('aria-pressed', String(clipSync));
    const label = clipSync ? 'Presse-papiers : synchronisé' : 'Presse-papiers : désactivé';
    el.clipBtn.title = label;
    el.clipBtn.setAttribute('aria-label', label);
  }

  el.clipBtn.addEventListener('click', () => {
    clipSync = !clipSync;
    writePref('bifrost.clip', clipSync);
    renderClipButton();
  });

  el.clipPending.addEventListener('click', async () => {
    if (pendingClip === null) return;
    try {
      await navigator.clipboard.writeText(pendingClip);
      pendingClip = null;
      el.clipPending.hidden = true;
    } catch {
      /* the browser still refuses: keep the button */
    }
  });

  /** The remote clipboard changed. */
  async function onRemoteClip(text) {
    if (!clipSync || !perms.clipboard || typeof text !== 'string') return;
    try {
      await navigator.clipboard.writeText(text);
      pendingClip = null;
      el.clipPending.hidden = true;
    } catch {
      // Some browsers only allow writing from a click: offer a button instead of failing silently.
      pendingClip = text;
      el.clipPending.hidden = false;
    }
  }

  let ackWaiter = null;

  /** Resolves when the host confirmed it set its clipboard (or after ms). */
  function waitClipboardAck(ms = 800) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        ackWaiter = null;
        resolve(false);
      }, ms);
      ackWaiter = () => {
        clearTimeout(timer);
        ackWaiter = null;
        resolve(true);
      };
    });
  }

  /** Text of the local clipboard to push before a remote Ctrl+V, or null. */
  async function localClipboardForPaste() {
    if (!clipSync || !perms.clipboard || !io) return null;
    try {
      const text = await navigator.clipboard.readText();
      return text || null;
    } catch {
      return null; // permission refused or clipboard not text
    }
  }

  // --- files: listing ----------------------------------------------------------------------

  function setHint(text, isError = false) {
    el.hint.textContent = text;
    el.hint.classList.toggle('error', isError);
  }

  function renderCrumb() {
    el.crumb.replaceChildren();
    const parts = dir.split('/').filter(Boolean);
    const add = (label, path) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => refresh(path));
      el.crumb.append(b);
    };
    add('Partages', '/');
    parts.forEach((p, i) => add(p, '/' + parts.slice(0, i + 1).join('/')));
  }

  function renderEntries(entries) {
    el.entries.replaceChildren();
    if (dir !== '/' && dir.split('/').filter(Boolean).length > 0) {
      const up = '/' + dir.split('/').filter(Boolean).slice(0, -1).join('/');
      el.entries.append(entryRow({ name: '..', dir: true }, up === '/' ? '/' : up, true));
    }
    if (entries.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'Dossier vide.';
      el.entries.append(li);
    }
    for (const entry of entries) el.entries.append(entryRow(entry));
  }

  function entryRow(entry, target = null, isUp = false) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    const full = target ?? (dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`);
    if (entry.dir) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = isUp ? '↑ Dossier parent' : `📁 ${entry.name}`;
      b.addEventListener('click', () => refresh(full));
      name.append(b);
    } else {
      name.textContent = entry.name;
    }
    li.append(name);
    if (!entry.dir) {
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = humanSize(entry.size);
      li.append(meta);
      const root = perms.roots.find((r) => full.startsWith(`/${r.name}/`));
      if (root?.read) {
        const dl = document.createElement('button');
        dl.type = 'button';
        dl.textContent = 'Télécharger';
        dl.addEventListener('click', () => startDownload(entry, full));
        li.append(dl);
      }
    }
    return li;
  }

  async function refresh(path = dir) {
    if (!canFiles()) return;
    try {
      const res = await transfers.list(path);
      dir = res.path || path;
      renderCrumb();
      renderEntries(res.entries);
      const w = writableRoot();
      setHint(
        w
          ? `Les fichiers envoyés arrivent dans « ${w.name} » sur l’ordinateur distant. Vous pouvez aussi les glisser sur l’écran.`
          : 'Aucun dossier de dépôt : seul le téléchargement est possible.',
      );
      el.uploadLabel.hidden = !w;
    } catch (err) {
      setHint(err instanceof TransferError ? err.message : 'Impossible de lister ce dossier.', true);
    }
  }

  // --- files: transfers --------------------------------------------------------------------

  function addRow(label) {
    const li = document.createElement('li');
    li.className = 'transfer';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = label;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = 'en attente…';
    const bar = document.createElement('progress');
    bar.max = 1;
    bar.value = 0;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Annuler';
    li.append(name, meta, cancel, bar);
    el.transferList.prepend(li);
    return {
      progress(done, total) {
        bar.max = total || 1;
        bar.value = done;
        meta.textContent = `${humanSize(done)} / ${humanSize(total)}`;
      },
      done(text) {
        meta.textContent = text;
        bar.remove();
        cancel.remove();
      },
      fail(text) {
        li.classList.add('error');
        meta.textContent = text;
        bar.remove();
        cancel.remove();
      },
      onCancel(fn) {
        cancel.addEventListener('click', fn);
      },
    };
  }

  function uploadDir() {
    const w = writableRoot();
    if (!w) return null;
    const inside = perms.roots.find((r) => r.write && (dir === `/${r.name}` || dir.startsWith(`/${r.name}/`)));
    return inside ? dir : `/${w.name}`;
  }

  function uploadFiles(files) {
    if (!canFiles()) return;
    const target = uploadDir();
    if (!target) {
      setHint('Aucun dossier de dépôt n’est partagé sur cet ordinateur.', true);
      return;
    }
    for (const file of files) {
      const row = addRow(`↑ ${file.name}`);
      const { id, promise } = transfers.upload(file, target, (done, total) => row.progress(done, total));
      row.onCancel(() => transfers.cancel(id));
      promise
        .then((res) => {
          row.done(`envoyé (${humanSize(res.size)})`);
          if (dir === target) refresh(dir);
        })
        .catch((err) => row.fail(err instanceof TransferError ? err.message : 'échec'));
    }
  }

  async function startDownload(entry, path) {
    if (!canFiles()) return;
    let sink;
    try {
      sink = await makeSink(entry);
    } catch (err) {
      if (err?.name !== 'AbortError') setHint('Impossible de créer le fichier local.', true);
      return; // the user cancelled the save dialog
    }
    if (!sink) return;
    const row = addRow(`↓ ${entry.name}`);
    const { id, promise } = transfers.download(path, sink, (done, total) => row.progress(done, total));
    row.onCancel(() => transfers.cancel(id));
    promise
      .then((res) => row.done(`reçu (${humanSize(res.size)})`))
      .catch((err) => row.fail(err instanceof TransferError ? err.message : 'échec'));
  }

  /** Where a downloaded file goes: straight to disk when possible, else a Blob in memory. */
  async function makeSink(entry) {
    if (typeof window.showSaveFilePicker === 'function') {
      // Must run inside the click that started the download (user activation).
      const handle = await window.showSaveFilePicker({ suggestedName: entry.name });
      const writable = await handle.createWritable();
      return {
        write: (bytes) => writable.write(bytes),
        close: () => writable.close(),
        abort: () => writable.abort().catch(() => {}),
      };
    }
    if (entry.size > BLOB_FALLBACK_LIMIT) {
      setHint('Fichier trop gros pour ce navigateur : utilisez Chrome ou Edge pour les gros fichiers.', true);
      return null;
    }
    const parts = [];
    return {
      write: (bytes) => parts.push(bytes),
      close: () => {
        const url = URL.createObjectURL(new Blob(parts));
        const a = document.createElement('a');
        a.href = url;
        a.download = entry.name;
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      },
      abort: () => (parts.length = 0),
    };
  }

  // --- panel + drag and drop ---------------------------------------------------------------

  function setPanel(open) {
    el.panel.hidden = !open;
    el.filesBtn.setAttribute('aria-expanded', String(open));
    if (open) refresh(dir || '/');
  }
  el.filesBtn.addEventListener('click', () => setPanel(el.panel.hidden));
  el.close.addEventListener('click', () => setPanel(false));
  el.upload.addEventListener('change', () => {
    uploadFiles([...el.upload.files]);
    el.upload.value = '';
  });

  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  el.stage.addEventListener('dragover', (e) => {
    if (!canFiles() || !hasFiles(e)) return;
    e.preventDefault();
    el.dropHint.hidden = false;
  });
  el.stage.addEventListener('dragleave', (e) => {
    if (e.target === el.stage || e.target === el.dropHint) el.dropHint.hidden = true;
  });
  el.stage.addEventListener('drop', (e) => {
    el.dropHint.hidden = true;
    if (!canFiles() || !hasFiles(e)) return;
    e.preventDefault();
    if (el.panel.hidden) setPanel(true);
    uploadFiles([...e.dataTransfer.files]);
  });

  // --- session binding ---------------------------------------------------------------------

  return {
    start(ioHandlers) {
      io = ioHandlers;
      transfers = new TransferClient({
        sendJson: (m) => io?.sendJson(m),
        sendChunk: (id, last, bytes) => io?.sendChunk(id, last, bytes),
        bufferedAmount: () => io?.bufferedAmount() ?? 0,
      });
      perms = { clipboard: false, files: 'deny', roots: [] };
      dir = '/';
    },

    stop() {
      transfers?.abortAll();
      transfers = null;
      io = null;
      perms = { clipboard: false, files: 'deny', roots: [] };
      pendingClip = null;
      for (const n of [el.clipBtn, el.clipPending, el.filesBtn, el.panel, el.dropHint]) n.hidden = true;
      el.entries.replaceChildren();
      el.transferList.replaceChildren();
    },

    /** Decrypted JSON from the host. Returns true when it was consumed here. */
    onJson(msg) {
      if (!io) return false;
      if (msg.t === 'perm') {
        perms = {
          clipboard: msg.clipboard === true,
          files: msg.files === 'allow' || msg.files === 'ask' ? msg.files : 'deny',
          roots: Array.isArray(msg.roots) ? msg.roots.filter((r) => r && typeof r.name === 'string') : [],
        };
        renderClipButton();
        el.filesBtn.hidden = !canFiles();
        return true;
      }
      if (msg.t === 'clip') {
        onRemoteClip(msg.text);
        return true;
      }
      if (msg.t === 'clip-set') {
        ackWaiter?.();
        return true;
      }
      return transfers?.handle(msg) ?? false;
    },

    onFileChunk(chunk) {
      transfers?.handleChunk(chunk);
    },

    localClipboardForPaste,
    waitClipboardAck,
  };
}

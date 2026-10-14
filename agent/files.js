import fs from 'node:fs';
import path from 'node:path';

export const CHUNK_SIZE = 32 * 1024; // the relay caps viewer packets at 64 KB, AES-GCM adds ~25 bytes
export const DEFAULT_MAX_FILE_BYTES = 4 * 1024 ** 3;

const MAX_ACTIVE = 4;
const MAX_ENTRIES = 2000;
const BACKLOG_LIMIT = 1024 * 1024;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;

/** A file name that is safe to create on Windows, or null. Never contains a path. */
export function safeName(name) {
  if (typeof name !== 'string') return null;
  const n = name.normalize('NFC');
  if (n.length === 0 || n.length > 200) return null;
  if (n === '.' || n === '..') return null;
  if (INVALID_CHARS.test(n)) return null;
  if (/[. ]$/.test(n)) return null; // Windows silently strips trailing dots and spaces
  if (RESERVED.test(n)) return null;
  return n;
}

/** `name.ext` -> `name (1).ext`, ... first free name in dir. */
export function uniqueName(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  throw new Error('no free name');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} Ko`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
  return `${(bytes / 1024 ** 3).toFixed(2)} Go`;
}

/**
 * File transfer between a viewer and the host, restricted to declared share roots.
 *
 * Virtual paths ("/Inbox/photos/a.jpg") start with a root name; the real directories are
 * never revealed. Every path is resolved with realpath and must stay inside its root, which
 * also rejects symbolic links and junctions that point elsewhere.
 *
 * Messages (JSON, from the viewer):  fs-list, fs-get, fs-put, fs-cancel
 * Replies:                           fs-list-r, fs-get-r, fs-put-r, fs-done, fs-error
 * Data travels in chunks: send(id, last, bytes) / onChunk(id, last, bytes).
 */
export class FileService {
  /**
   * @param {{name:string, dir:string, read:boolean, write:boolean}[]} roots
   * @param {'ask'|'allow'|'deny'} policy
   * @param {(q:{title:string,text:string}) => Promise<boolean>} ask
   */
  constructor({ roots, policy = 'ask', ask, send, sendChunk, bufferedAmount = () => 0, log = () => {}, maxFileBytes = DEFAULT_MAX_FILE_BYTES }) {
    this.roots = roots;
    this.policy = policy;
    this.ask = ask;
    this.send = send;
    this.sendChunk = sendChunk;
    this.bufferedAmount = bufferedAmount;
    this.log = log;
    this.maxFileBytes = maxFileBytes;
    this.active = new Map(); // id -> transfer
    this.askQueue = Promise.resolve();
    this.closed = false;
  }

  /** Dispatches a viewer message. Resolves when handled (transfers continue in the background). */
  async handle(msg) {
    if (this.closed || !msg || typeof msg.t !== 'string') return;
    const id = Number.isInteger(msg.id) && msg.id >= 0 && msg.id < 2 ** 32 ? msg.id : null;
    try {
      if (this.policy === 'deny' || this.roots.length === 0) {
        if (msg.t.startsWith('fs-') && msg.t !== 'fs-cancel') return this.send({ t: 'fs-error', id, reason: 'disabled' });
        return;
      }
      switch (msg.t) {
        case 'fs-list':
          return this.#list(id, msg.path);
        case 'fs-get':
          return await this.#get(id, msg.path);
        case 'fs-put':
          return await this.#put(id, msg);
        case 'fs-cancel':
          if (id !== null) this.#abort(id, null);
          return undefined;
        default:
          return undefined;
      }
    } catch (err) {
      this.log(`fichiers : ${err.message}`);
      this.send({ t: 'fs-error', id, reason: 'io' });
    }
  }

  dispose() {
    this.closed = true;
    for (const id of [...this.active.keys()]) this.#abort(id, null);
  }

  // --- path resolution ---------------------------------------------------------------------

  /** @returns {{root, real, relative}|{error:string}} */
  #resolve(vpath, { mustExist = true } = {}) {
    if (typeof vpath !== 'string' || vpath.length > 1024) return { error: 'bad-path' };
    const parts = vpath.split('/').filter((p) => p !== '');
    if (parts.length === 0) return { error: 'bad-path' };
    const root = this.roots.find((r) => r.name === parts[0]);
    if (!root) return { error: 'not-found' };
    const segments = parts.slice(1);
    for (const s of segments) {
      if (s === '.' || s === '..' || INVALID_CHARS.test(s) || s.length > 255) return { error: 'bad-path' };
    }
    let rootReal;
    try {
      rootReal = fs.realpathSync.native(root.dir);
    } catch {
      return { error: 'not-found' };
    }
    const candidate = path.join(rootReal, ...segments);
    let real;
    try {
      real = fs.realpathSync.native(mustExist ? candidate : path.dirname(candidate));
      if (!mustExist) real = path.join(real, path.basename(candidate));
    } catch {
      return { error: 'not-found' };
    }
    const inside = real === rootReal || real.toLowerCase().startsWith((rootReal + path.sep).toLowerCase());
    if (!inside) return { error: 'not-allowed' }; // symlink/junction pointing out of the root
    return { root, real, rootReal, segments };
  }

  // --- listing -----------------------------------------------------------------------------

  #list(id, vpath) {
    const wantsRoots = typeof vpath !== 'string' || vpath.split('/').filter(Boolean).length === 0;
    if (wantsRoots) {
      const entries = this.roots.map((r) => ({ name: r.name, dir: true, size: 0, mtime: 0, read: r.read, write: r.write }));
      return this.send({ t: 'fs-list-r', id, path: '/', entries });
    }
    const r = this.#resolve(vpath);
    if (r.error) return this.send({ t: 'fs-error', id, reason: r.error });
    if (!r.root.read) return this.send({ t: 'fs-error', id, reason: 'not-allowed' });
    let dirents;
    try {
      dirents = fs.readdirSync(r.real, { withFileTypes: true });
    } catch {
      return this.send({ t: 'fs-error', id, reason: 'not-found' });
    }
    const entries = [];
    for (const d of dirents.slice(0, MAX_ENTRIES)) {
      if (!safeName(d.name)) continue; // names we could not create ourselves are not offered either
      try {
        const st = fs.statSync(path.join(r.real, d.name));
        if (!st.isFile() && !st.isDirectory()) continue;
        entries.push({ name: d.name, dir: st.isDirectory(), size: st.isFile() ? st.size : 0, mtime: Math.round(st.mtimeMs) });
      } catch {
        /* vanished or unreadable */
      }
    }
    entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    const shown = '/' + [r.root.name, ...r.segments].join('/');
    return this.send({ t: 'fs-list-r', id, path: shown, entries });
  }

  // --- consent -----------------------------------------------------------------------------

  async #authorize(title, text) {
    if (this.policy === 'allow') return true;
    // One dialog at a time, in request order.
    const run = this.askQueue.then(() => this.ask({ title, text }));
    this.askQueue = run.catch(() => {});
    return run;
  }

  #register(id, transfer) {
    if (id === null) return false;
    if (this.active.has(id) || this.active.size >= MAX_ACTIVE) return false;
    this.active.set(id, transfer);
    return true;
  }

  #abort(id, reason) {
    const t = this.active.get(id);
    if (!t) return;
    this.active.delete(id);
    t.cancelled = true;
    if (t.fd !== undefined) {
      try {
        fs.closeSync(t.fd);
      } catch {
        /* closed */
      }
      if (t.part) fs.rmSync(t.part, { force: true });
    }
    if (reason) this.send({ t: 'fs-error', id, reason });
  }

  // --- download (host -> viewer) -----------------------------------------------------------

  async #get(id, vpath) {
    const r = this.#resolve(vpath);
    if (r.error) return this.send({ t: 'fs-error', id, reason: r.error });
    if (!r.root.read) return this.send({ t: 'fs-error', id, reason: 'not-allowed' });
    let st;
    try {
      st = fs.statSync(r.real);
    } catch {
      return this.send({ t: 'fs-error', id, reason: 'not-found' });
    }
    if (!st.isFile()) return this.send({ t: 'fs-error', id, reason: 'not-a-file' });
    if (st.size > this.maxFileBytes) return this.send({ t: 'fs-error', id, reason: 'too-large' });

    const name = path.basename(r.real);
    const transfer = { dir: 'get', cancelled: false };
    if (!this.#register(id, transfer)) return this.send({ t: 'fs-error', id, reason: 'busy' });

    const yes = await this.#authorize(
      'Bifrost - Transfert de fichier',
      `Une personne veut récupérer le fichier « ${name} » (${humanSize(st.size)}) depuis cet ordinateur.\n\nAutoriser ?`,
    );
    if (!yes || transfer.cancelled) {
      this.active.delete(id);
      return this.send({ t: 'fs-error', id, reason: 'refused' });
    }

    this.send({ t: 'fs-get-r', id, name, size: st.size });
    this.log(`fichier envoyé : ${name} (${st.size} o)`);
    let sent = 0;
    try {
      const fd = fs.openSync(r.real, 'r');
      transfer.fd = fd;
      const buf = Buffer.alloc(CHUNK_SIZE);
      for (;;) {
        if (transfer.cancelled) return;
        while (this.bufferedAmount() > BACKLOG_LIMIT) {
          await sleep(10);
          if (transfer.cancelled) return;
        }
        const n = fs.readSync(fd, buf, 0, CHUNK_SIZE, null);
        sent += n;
        const last = n < CHUNK_SIZE || sent >= st.size;
        this.sendChunk(id, last, Buffer.from(buf.subarray(0, n)));
        if (last) break;
      }
    } catch {
      this.#abort(id, 'io');
      return;
    }
    if (this.active.get(id) === transfer) {
      try {
        fs.closeSync(transfer.fd);
      } catch {
        /* closed */
      }
      this.active.delete(id);
    }
  }

  // --- upload (viewer -> host) -------------------------------------------------------------

  async #put(id, msg) {
    const name = safeName(msg.name);
    if (!name) return this.send({ t: 'fs-error', id, reason: 'bad-name' });
    const size = msg.size;
    if (!Number.isInteger(size) || size < 0) return this.send({ t: 'fs-error', id, reason: 'bad-size' });
    if (size > this.maxFileBytes) return this.send({ t: 'fs-error', id, reason: 'too-large' });

    const target = typeof msg.dir === 'string' && msg.dir ? msg.dir : `/${(this.roots.find((r) => r.write) ?? {}).name}`;
    const r = this.#resolve(target);
    if (r.error) return this.send({ t: 'fs-error', id, reason: r.error });
    if (!r.root.write) return this.send({ t: 'fs-error', id, reason: 'not-allowed' });
    let dirStat;
    try {
      dirStat = fs.statSync(r.real);
    } catch {
      return this.send({ t: 'fs-error', id, reason: 'not-found' });
    }
    if (!dirStat.isDirectory()) return this.send({ t: 'fs-error', id, reason: 'not-a-directory' });

    const transfer = { dir: 'put', cancelled: false, received: 0, size };
    if (!this.#register(id, transfer)) return this.send({ t: 'fs-error', id, reason: 'busy' });

    const yes = await this.#authorize(
      'Bifrost - Transfert de fichier',
      `Une personne veut déposer le fichier « ${name} » (${humanSize(size)}) sur cet ordinateur.\n\nAutoriser ?`,
    );
    if (!yes || transfer.cancelled) {
      this.active.delete(id);
      return this.send({ t: 'fs-error', id, reason: 'refused' });
    }

    try {
      const finalName = uniqueName(r.real, name);
      transfer.final = path.join(r.real, finalName);
      transfer.part = `${transfer.final}.bifrost-part`;
      transfer.fd = fs.openSync(transfer.part, 'wx');
      transfer.name = finalName;
      transfer.virtual = '/' + [r.root.name, ...r.segments, finalName].join('/');
    } catch {
      this.#abort(id, 'io');
      return;
    }
    this.send({ t: 'fs-put-r', id, name: transfer.name, path: transfer.virtual });
  }

  /** A data chunk of an upload. */
  onChunk(id, last, data) {
    const t = this.active.get(id);
    if (!t || t.dir !== 'put' || t.fd === undefined || t.cancelled) return;
    t.received += data.length;
    if (t.received > t.size) return this.#abort(id, 'size');
    try {
      fs.writeSync(t.fd, data);
    } catch {
      return this.#abort(id, 'io');
    }
    if (!last) return;
    try {
      fs.closeSync(t.fd);
      if (t.received !== t.size) {
        fs.rmSync(t.part, { force: true });
        this.active.delete(id);
        return this.send({ t: 'fs-error', id, reason: 'size' });
      }
      fs.renameSync(t.part, t.final);
    } catch {
      this.active.delete(id);
      return this.send({ t: 'fs-error', id, reason: 'io' });
    }
    this.active.delete(id);
    this.log(`fichier reçu : ${t.name} (${t.size} o)`);
    this.send({ t: 'fs-done', id, name: t.name, size: t.size, path: t.virtual });
  }
}

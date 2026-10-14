// Viewer side of file transfer. DOM-free: it talks to the host through three callbacks, so the
// same code is exercised in Node by the tests (against the real FileService).
//
//   sendJson(obj)                  encrypted JSON message to the host
//   sendChunk(id, last, bytes)     encrypted file chunk to the host
//   bufferedAmount()               bytes waiting in the WebSocket (upload backpressure)

export const CHUNK_SIZE = 32 * 1024; // the relay drops viewer packets above 64 KB

const REASONS = {
  refused: 'La personne devant l’ordinateur a refusé.',
  disabled: 'Le transfert de fichiers est désactivé sur cet ordinateur.',
  'not-allowed': 'Ce dossier n’est pas partagé.',
  'not-found': 'Introuvable.',
  'not-a-file': 'Ce n’est pas un fichier.',
  'not-a-directory': 'Ce n’est pas un dossier.',
  'too-large': 'Fichier trop volumineux.',
  'bad-name': 'Nom de fichier non accepté (caractères interdits ou nom réservé).',
  'bad-path': 'Chemin non valide.',
  'bad-size': 'Taille non valide.',
  size: 'Le fichier reçu est incomplet.',
  busy: 'Trop de transferts en cours.',
  io: 'Erreur d’écriture ou de lecture sur l’ordinateur distant.',
  cancelled: 'Transfert annulé.',
};

export class TransferError extends Error {
  constructor(reason) {
    super(REASONS[reason] ?? `Erreur (${reason}).`);
    this.reason = reason;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TransferClient {
  constructor({ sendJson, sendChunk, bufferedAmount = () => 0, chunkSize = CHUNK_SIZE, maxBuffered = 1024 * 1024 }) {
    this.sendJson = sendJson;
    this.sendChunk = sendChunk;
    this.bufferedAmount = bufferedAmount;
    this.chunkSize = chunkSize;
    this.maxBuffered = maxBuffered;
    this.nextId = 1;
    this.transfers = new Map();
  }

  #open(kind) {
    const id = this.nextId++;
    const t = { id, kind, cancelled: false, received: 0, chain: Promise.resolve() };
    t.promise = new Promise((resolve, reject) => {
      t.resolve = resolve;
      t.reject = reject;
    });
    this.transfers.set(id, t);
    return t;
  }

  #finish(t, error, value) {
    if (!this.transfers.delete(t.id)) return;
    if (error) t.reject(error instanceof Error ? error : new TransferError(error));
    else t.resolve(value);
  }

  /** Rejects every pending transfer (connection lost). */
  abortAll(reason = 'cancelled') {
    for (const t of [...this.transfers.values()]) {
      t.cancelled = true;
      t.sink?.abort?.();
      this.#finish(t, reason);
    }
  }

  cancel(id) {
    const t = this.transfers.get(id);
    if (!t) return;
    t.cancelled = true;
    this.sendJson({ t: 'fs-cancel', id });
    t.sink?.abort?.();
    this.#finish(t, 'cancelled');
  }

  // --- API ---------------------------------------------------------------------------------

  /** @returns {Promise<{path:string, entries:{name:string,dir:boolean,size:number,mtime:number}[]}>} */
  list(path = '/') {
    const t = this.#open('list');
    this.sendJson({ t: 'fs-list', id: t.id, path });
    return t.promise;
  }

  /**
   * Sends a File/Blob to a directory of the host.
   * @returns {{ id:number, promise:Promise<{name:string,size:number,path:string}> }}
   */
  upload(file, dir, onProgress = () => {}) {
    const t = this.#open('put');
    t.file = file;
    t.onProgress = onProgress;
    t.ready = new Promise((resolve) => (t.readyResolve = resolve));
    this.sendJson({ t: 'fs-put', id: t.id, name: file.name, size: file.size, dir });
    this.#pump(t);
    return { id: t.id, promise: t.promise };
  }

  async #pump(t) {
    try {
      await t.ready; // the host answered fs-put-r (it may first ask its user)
      if (t.cancelled) return;
      const size = t.file.size;
      let offset = 0;
      do {
        while (this.bufferedAmount() > this.maxBuffered) {
          await sleep(10);
          if (t.cancelled) return;
        }
        const end = Math.min(offset + this.chunkSize, size);
        const bytes = new Uint8Array(await t.file.slice(offset, end).arrayBuffer());
        offset = end;
        this.sendChunk(t.id, offset >= size, bytes);
        t.onProgress(offset, size);
      } while (offset < size);
    } catch {
      this.#finish(t, 'io');
    }
  }

  /**
   * Fetches a file of the host into `sink`:
   *   { open?(name, size), write(Uint8Array), close(), abort?() } (all may be async).
   * @returns {{ id:number, promise:Promise<{name:string,size:number}> }}
   */
  download(path, sink, onProgress = () => {}) {
    const t = this.#open('get');
    t.sink = sink;
    t.onProgress = onProgress;
    this.sendJson({ t: 'fs-get', id: t.id, path });
    return { id: t.id, promise: t.promise };
  }

  // --- replies -----------------------------------------------------------------------------

  /** A decrypted JSON message from the host. Returns true when it was an fs reply. */
  handle(msg) {
    if (!msg || typeof msg.t !== 'string' || !msg.t.startsWith('fs-')) return false;
    const t = this.transfers.get(msg.id);
    if (!t) return true;
    switch (msg.t) {
      case 'fs-error':
        t.sink?.abort?.();
        this.#finish(t, msg.reason ?? 'io');
        break;
      case 'fs-list-r':
        this.#finish(t, null, { path: msg.path, entries: msg.entries ?? [] });
        break;
      case 'fs-put-r':
        t.name = msg.name;
        t.readyResolve();
        break;
      case 'fs-done':
        this.#finish(t, null, { name: msg.name, size: msg.size, path: msg.path });
        break;
      case 'fs-get-r':
        t.name = msg.name;
        t.size = msg.size;
        t.opened = Promise.resolve(t.sink.open?.(msg.name, msg.size)).catch(() => {
          this.cancel(t.id);
        });
        break;
      default:
    }
    return true;
  }

  /** A decrypted file chunk of a download. */
  handleChunk({ id, last, data }) {
    const t = this.transfers.get(id);
    if (!t || t.kind !== 'get' || t.cancelled) return;
    t.received += data.length;
    const bytes = new Uint8Array(data); // copy: the packet buffer is not ours to keep
    t.chain = t.chain
      .then(async () => {
        await t.opened;
        if (t.cancelled) return;
        if (bytes.length) await t.sink.write(bytes);
        t.onProgress(t.received, t.size);
        if (!last) return;
        if (t.received !== t.size) {
          t.sink.abort?.();
          return this.#finish(t, 'size');
        }
        await t.sink.close();
        this.#finish(t, null, { name: t.name, size: t.size });
      })
      .catch(() => {
        t.sink.abort?.();
        this.#finish(t, 'io');
      });
  }
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sha256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * Binds a public ID to the hash of the host secret that first claimed it.
 * Only the hash is stored. Persisted atomically as JSON so IDs survive restarts.
 */
export class Registry {
  constructor(dataDir) {
    this.file = dataDir ? path.join(dataDir, 'ids.json') : null;
    this.map = new Map();
    this.pending = null;
    if (this.file) {
      fs.mkdirSync(dataDir, { recursive: true });
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        for (const [id, hash] of Object.entries(raw)) this.map.set(id, hash);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
  }

  /** @returns {'ok'|'taken'} */
  claim(id, secret) {
    const hash = sha256Hex(secret);
    const existing = this.map.get(id);
    if (existing === undefined) {
      this.map.set(id, hash);
      this.#schedulePersist();
      return 'ok';
    }
    const a = Buffer.from(existing, 'hex');
    const b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? 'ok' : 'taken';
  }

  #schedulePersist() {
    if (!this.file || this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      this.flush();
    }, 200);
    this.pending.unref?.();
  }

  flush() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deriveKey, idFromSecret, randomB64, toB64, PBKDF2_ITERATIONS } from '../shared/auth.js';

export function configPath() {
  const base = process.env.APPDATA ?? path.join(os.homedir(), '.config');
  return path.join(base, 'Bifrost', 'agent.json');
}

/** Machine-wide data directory used by the Windows service (BIFROST_DATA_DIR overrides, for tests). */
export function serviceDataDir() {
  return process.env.BIFROST_DATA_DIR || path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Bifrost');
}

export function loadConfig(file = configPath()) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

export function saveConfig(cfg, file = configPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Creates the host identity (random secret + derived 9-digit ID) on first run. */
export async function ensureIdentity(cfg, { reroll = false } = {}) {
  if (!cfg.secret || reroll) {
    cfg.secret = randomB64(32);
    cfg.id = await idFromSecret(cfg.secret);
  }
  return cfg;
}

/** Stores a derived key, never the password itself. */
export async function setPassword(cfg, password) {
  cfg.passwordSalt = randomB64(16);
  cfg.passwordIters = PBKDF2_ITERATIONS;
  cfg.passwordKey = toB64(await deriveKey(password, cfg.passwordSalt, cfg.passwordIters));
  return cfg;
}

export function clearPassword(cfg) {
  delete cfg.passwordSalt;
  delete cfg.passwordIters;
  delete cfg.passwordKey;
  return cfg;
}

export function normalizeServerUrl(input) {
  const u = new URL(/^[a-z]+:\/\//i.test(input) ? input : `ws://${input}`);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  if (u.protocol === 'https:') u.protocol = 'wss:';
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/ws';
  return u.toString();
}

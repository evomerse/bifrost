import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NATIVE_SOURCES = ['BifrostCapture.cs', 'Codec.cs', 'Mf.cs'];

/** The C# compiler that ships with Windows (.NET Framework 4.x): no SDK to install. */
export function cscPath() {
  const p = path.join(process.env.windir ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  return fs.existsSync(p) ? p : null;
}

export function nativeSourceDir(repoRoot = REPO_ROOT) {
  return path.join(repoRoot, 'native');
}

/** Hash of the native sources: rebuilds happen exactly when they change. */
export function nativeSourceHash(repoRoot = REPO_ROOT) {
  const h = crypto.createHash('sha256');
  for (const f of NATIVE_SOURCES) h.update(fs.readFileSync(path.join(nativeSourceDir(repoRoot), f)));
  return h.digest('hex').slice(0, 12);
}

/**
 * A just-compiled executable is often locked for a moment while Windows Defender (or another
 * scanner) inspects it, and starting it then fails with "spawn UNKNOWN". Wait until it can be
 * opened exclusively. Returns true when it became available.
 */
export function waitUntilUsable(file, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(file, 'r+'));
      return true;
    } catch {
      if (Date.now() > end) return false;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

export function buildCaptureExe({ outFile, repoRoot = REPO_ROOT }) {
  const csc = cscPath();
  if (!csc) throw new Error('Compilateur C# de .NET Framework introuvable (csc.exe).');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const dir = nativeSourceDir(repoRoot);
  const r = spawnSync(
    csc,
    [
      '/nologo', '/unsafe', '/optimize+', '/target:exe', '/platform:x64',
      `/out:${outFile}`, '/reference:System.Drawing.dll',
      ...NATIVE_SOURCES.map((f) => path.join(dir, f)),
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`Compilation de BifrostCapture échouée :\n${r.stdout}${r.stderr}`);
  waitUntilUsable(outFile);
}

/**
 * Where the capture helper lives:
 *  1. agent/bin/BifrostCapture.exe next to the scripts (installed service, built at install);
 *  2. otherwise built on demand from native/ into a per-user cache named after the source hash.
 * Returns null when it cannot be had; the caller then falls back to capture.ps1 (JPEG).
 */
export function resolveCaptureExe(agentDir, log = () => {}) {
  const bundled = path.join(agentDir, 'bin', 'BifrostCapture.exe');
  if (fs.existsSync(bundled)) return bundled;

  try {
    const sources = nativeSourceDir(path.resolve(agentDir, '..'));
    if (!fs.existsSync(path.join(sources, NATIVE_SOURCES[0])) || !cscPath()) return null;
    const hash = nativeSourceHash(path.resolve(agentDir, '..'));
    const cache = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'Bifrost', 'bin');
    const exe = path.join(cache, `BifrostCapture-${hash}.exe`);
    if (!fs.existsSync(exe)) {
      log(`Compilation de l'assistant de capture (${hash})…`);
      buildCaptureExe({ outFile: exe, repoRoot: path.resolve(agentDir, '..') });
    } else {
      waitUntilUsable(exe, 3000); // another process may have just written it
    }
    return exe;
  } catch (err) {
    log(`Assistant de capture indisponible, repli sur JPEG : ${err.message}`);
    return null;
  }
}

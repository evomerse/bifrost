// Updates from GitHub Releases. The app asks the releases API of its repository, compares the
// version, and (when it runs from a packaged folder) downloads the build for this platform,
// checks its SHA-256 against the SHA256SUMS file of the release, then replaces its own folder
// once it has quit and starts again.
//
// Asset names (produced by .github/workflows/release.yml):
//   Bifrost-<tag>-<platform>-<arch>.zip          (win32)
//   Bifrost-<tag>-<platform>-<arch>.tar.gz       (darwin, linux)
//   SHA256SUMS.txt
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFile } from 'node:child_process';

export const DEFAULT_REPO = 'evomerse/bifrost';

/** "v1.2.3" / "1.2.3-beta.1" -> [1,2,3]; null when it is not a version. */
export function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** > 0 when a is newer than b. Unparseable versions never count as newer. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** bsdtar reads both .zip and .tar.gz; on Windows use the system one, not a GNU tar from PATH. */
export const tarCommand = (platform) =>
  platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe') : 'tar';

export const archiveExt = (platform) => (platform === 'win32' ? '.zip' : '.tar.gz');

/** The release asset built for this platform, or null. */
export function pickAsset(release, platform = process.platform, arch = process.arch) {
  const suffix = `-${platform}-${arch}${archiveExt(platform)}`;
  const a = (release?.assets ?? []).find((x) => typeof x.name === 'string' && x.name.endsWith(suffix) && x.name.startsWith('Bifrost-'));
  return a ? { name: a.name, url: a.browser_download_url, size: a.size } : null;
}

/** "<sha256>  <name>" lines (sha256sum format) -> hex digest of `name`, or null. */
export function findChecksum(sumsText, name) {
  for (const line of String(sumsText ?? '').split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  return null;
}

/** Windows script: waits for the app to exit, swaps the folders, starts the app again. */
export const WINDOWS_SWAP = `param([int]$ParentPid, [string]$Src, [string]$Dst, [string]$Exe, [string]$Work)
$ErrorActionPreference = 'Stop'
$log = Join-Path $Work 'update.log'
function Log($m) { Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format s), $m) }
try {
  for ($i = 0; $i -lt 120; $i++) { if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 500 }
  Start-Sleep -Seconds 1
  $old = "$Dst.old"
  if (Test-Path $old) { Remove-Item -Recurse -Force $old }
  $moved = $false
  for ($i = 0; $i -lt 20 -and -not $moved; $i++) {
    try { Move-Item -LiteralPath $Dst -Destination $old; $moved = $true } catch { Start-Sleep -Milliseconds 700 }
  }
  if (-not $moved) { throw 'dossier verrouille' }
  try {
    Move-Item -LiteralPath $Src -Destination $Dst
  } catch {
    Move-Item -LiteralPath $old -Destination $Dst
    throw
  }
  Log 'ok'
  Start-Process -FilePath $Exe
  Start-Sleep -Seconds 3
  Remove-Item -Recurse -Force $old -ErrorAction SilentlyContinue
} catch {
  Log ("echec: " + $_)
  if (Test-Path $Exe) { Start-Process -FilePath $Exe }
}
`;

/** macOS / Linux counterpart. */
export const POSIX_SWAP = `#!/bin/sh
PARENT="$1"; SRC="$2"; DST="$3"; EXE="$4"; WORK="$5"
LOG="$WORK/update.log"
i=0
while kill -0 "$PARENT" 2>/dev/null && [ $i -lt 120 ]; do sleep 0.5; i=$((i+1)); done
sleep 1
OLD="$DST.old"
rm -rf "$OLD"
if mv "$DST" "$OLD" && mv "$SRC" "$DST"; then
  echo "ok" >> "$LOG"
  "$EXE" >/dev/null 2>&1 &
  sleep 3
  rm -rf "$OLD"
else
  echo "echec" >> "$LOG"
  [ -d "$OLD" ] && [ ! -d "$DST" ] && mv "$OLD" "$DST"
  "$EXE" >/dev/null 2>&1 &
fi
`;

export class Updater {
  /**
   * @param {object} o
   * @param {string} o.currentVersion
   * @param {string} [o.repo]            "owner/name"
   * @param {typeof fetch} [o.fetchFn]
   * @param {string} [o.platform]
   * @param {string} [o.arch]
   * @param {string|null} o.installDir   folder of the packaged app (null when run from the sources)
   * @param {string} o.exePath           the app's executable
   * @param {(m:string)=>void} [o.log]
   */
  constructor({ currentVersion, repo = DEFAULT_REPO, fetchFn = fetch, platform = process.platform, arch = process.arch, installDir = null, exePath = process.execPath, log = () => {} }) {
    this.currentVersion = currentVersion;
    this.repo = repo;
    this.fetchFn = fetchFn;
    this.platform = platform;
    this.arch = arch;
    this.installDir = installDir;
    this.exePath = exePath;
    this.log = log;
    this.release = null;
  }

  get canInstall() {
    return Boolean(this.installDir);
  }

  /** -> { available, version, notes, pageUrl, asset, canInstall } or { available:false } */
  async check() {
    const res = await this.fetchFn(`https://api.github.com/repos/${this.repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'Bifrost-updater' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return { available: false, version: this.currentVersion };
    if (!res.ok) throw new Error(`GitHub a répondu ${res.status}.`);
    const rel = await res.json();
    this.release = rel;
    const version = String(rel.tag_name ?? '').replace(/^v/, '');
    const available = compareVersions(version, this.currentVersion) > 0;
    return {
      available,
      version,
      notes: String(rel.body ?? '').slice(0, 2000),
      pageUrl: typeof rel.html_url === 'string' && rel.html_url.startsWith('https://github.com/') ? rel.html_url : `https://github.com/${this.repo}/releases`,
      asset: pickAsset(rel, this.platform, this.arch),
      canInstall: this.canInstall && Boolean(pickAsset(rel, this.platform, this.arch)),
    };
  }

  /**
   * Downloads, verifies and unpacks the update, then starts the swap script. The caller must
   * quit the app right after it resolves. onProgress(0..1).
   */
  async install(onProgress = () => {}) {
    if (!this.canInstall) throw new Error('Cette copie de Bifrost ne peut pas se mettre à jour toute seule.');
    const rel = this.release;
    const asset = pickAsset(rel, this.platform, this.arch);
    if (!asset) throw new Error(`Aucune version pour ${this.platform}-${this.arch} dans cette publication.`);
    const sums = (rel.assets ?? []).find((a) => a.name === 'SHA256SUMS.txt');
    if (!sums) throw new Error('Publication sans fichier SHA256SUMS.txt : mise à jour refusée.');
    for (const u of [asset.url, sums.browser_download_url]) {
      if (typeof u !== 'string' || !u.startsWith(`https://github.com/${this.repo}/releases/download/`)) {
        throw new Error('Adresse de téléchargement inattendue : mise à jour refusée.');
      }
    }

    const sumsText = await (await this.fetchFn(sums.browser_download_url, { signal: AbortSignal.timeout(30_000) })).text();
    const expected = findChecksum(sumsText, asset.name);
    if (!expected) throw new Error('Empreinte SHA-256 introuvable pour ce fichier : mise à jour refusée.');

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-update-'));
    const archive = path.join(work, asset.name);
    const res = await this.fetchFn(asset.url, { signal: AbortSignal.timeout(15 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`Téléchargement impossible (${res.status}).`);
    const total = Number(res.headers.get('content-length')) || asset.size || 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(archive);
    let got = 0;
    for await (const chunk of res.body) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (total) onProgress(Math.min(1, got / total));
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    if (hash.digest('hex') !== expected) {
      fs.rmSync(work, { recursive: true, force: true });
      throw new Error('Empreinte SHA-256 différente : fichier corrompu ou altéré, mise à jour annulée.');
    }

    const unpacked = path.join(work, 'unpacked');
    fs.mkdirSync(unpacked);
    await new Promise((resolve, reject) =>
      execFile(tarCommand(this.platform), ['-xf', archive, '-C', unpacked], { windowsHide: true, timeout: 5 * 60_000 }, (err) =>
        err ? reject(new Error(`Décompression impossible : ${err.message}`)) : resolve(),
      ),
    );
    // the archive holds one folder (Bifrost-<platform>-<arch>)
    const entries = fs.readdirSync(unpacked);
    const folder = path.join(unpacked, entries.length === 1 ? entries[0] : '');
    const src = this.platform === 'darwin' ? path.join(folder, path.basename(this.installDir)) : folder;
    const newExe = path.join(src, path.relative(this.installDir, this.exePath));
    if (!fs.existsSync(newExe)) throw new Error('Archive inattendue (programme introuvable) : mise à jour annulée.');

    this.#spawnSwap({ src, work });
    return { work };
  }

  #spawnSwap({ src, work }) {
    const common = [String(process.pid), src, this.installDir, this.exePath, work];
    if (this.platform === 'win32') {
      const script = path.join(work, 'swap.ps1');
      fs.writeFileSync(script, WINDOWS_SWAP, 'utf8');
      // Launched through Start-Process: the script is then a process of its own, outside this
      // app's process tree, and keeps running after the app quits. (A child spawned directly
      // with Node's detached option was seen to die with its parent or never to start.)
      const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
      const quoted = (v) => `"${String(v).replace(/"/g, '')}"`;
      const list = [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', quoted(script),
        '-ParentPid', common[0], '-Src', quoted(common[1]), '-Dst', quoted(common[2]), '-Exe', quoted(common[3]), '-Work', quoted(common[4]),
      ].map(lit);
      const launcher = `Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList ${list.join(',')}`;
      const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', launcher], { windowsHide: true, timeout: 30_000 });
      if (r.error || r.status !== 0) throw new Error(`Impossible de lancer le script de mise à jour : ${r.error?.message ?? r.stderr?.toString().trim()}`);
      return;
    }
    const script = path.join(work, 'swap.sh');
    fs.writeFileSync(script, POSIX_SWAP, { mode: 0o700 });
    spawn('/bin/sh', [script, ...common], { detached: true, stdio: 'ignore' }).unref();
  }
}

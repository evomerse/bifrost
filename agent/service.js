import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, normalizeServerUrl, saveConfig, serviceDataDir } from './config.js';
import { buildCaptureExe, cscPath } from './native-build.js';

export { cscPath };

export const SERVICE_NAME = 'BifrostAgent';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Well-known SIDs (the * prefix is icacls syntax): independent of the Windows display language.
const SYSTEM = '*S-1-5-18';
const ADMINS = '*S-1-5-32-544';
const USERS = '*S-1-5-32-545';

export function installDir() {
  return path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Bifrost');
}

export function isElevated() {
  const r = spawnSync('whoami', ['/groups'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.includes('S-1-16-12288'); // High mandatory level
}


function run(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function icacls(target, ...grants) {
  run('icacls.exe', [target, '/inheritance:r', '/grant:r', ...grants, '/C', '/Q']);
}

/**
 * Copies exactly what the service needs. Everything the service executes as SYSTEM must live
 * in a location only administrators can write to, otherwise any program running as the
 * normal user could edit it and gain SYSTEM rights.
 */
export function stageFiles({ destDir, nodeExe = null, repoRoot = REPO_ROOT }) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const sub of ['agent', 'shared']) {
    const from = path.join(repoRoot, sub);
    const to = path.join(destDir, sub);
    fs.rmSync(to, { recursive: true, force: true });
    fs.mkdirSync(to, { recursive: true });
    for (const f of fs.readdirSync(from)) {
      if (/\.(js|ps1)$/.test(f)) fs.copyFileSync(path.join(from, f), path.join(to, f));
    }
  }
  fs.writeFileSync(
    path.join(destDir, 'package.json'),
    JSON.stringify({ name: 'bifrost-agent', private: true, type: 'module' }, null, 2),
  );
  const ws = path.join(repoRoot, 'node_modules', 'ws');
  if (!fs.existsSync(ws)) throw new Error('node_modules/ws introuvable : lancez "npm install" dans le dossier Bifrost.');
  fs.rmSync(path.join(destDir, 'node_modules'), { recursive: true, force: true });
  fs.cpSync(ws, path.join(destDir, 'node_modules', 'ws'), { recursive: true });
  if (nodeExe) {
    fs.mkdirSync(path.join(destDir, 'runtime'), { recursive: true });
    fs.copyFileSync(nodeExe, path.join(destDir, 'runtime', 'node.exe'));
  }
}

export function buildServiceExe({ outFile, repoRoot = REPO_ROOT }) {
  const csc = cscPath();
  if (!csc) throw new Error('Compilateur C# de .NET Framework introuvable (csc.exe).');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const r = spawnSync(
    csc,
    ['/nologo', '/target:exe', '/optimize+', `/out:${outFile}`, '/reference:System.ServiceProcess.dll', path.join(repoRoot, 'service', 'BifrostService.cs')],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`Compilation du service échouée :\n${r.stdout}${r.stderr}`);
}

// Owners we accept for existing service data: SYSTEM and the Administrators group.
const TRUSTED_OWNERS = new Set(['S-1-5-18', 'S-1-5-32-544']);

function ownerSid(target) {
  const quoted = target.replace(/'/g, "''");
  const r = spawnSync(
    'powershell.exe',
    [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Acl -LiteralPath '${quoted}').GetOwner([System.Security.Principal.SecurityIdentifier]).Value`,
    ],
    { encoding: 'utf8' },
  );
  return r.status === 0 ? r.stdout.trim() : null;
}

export function isTrustedOwner(target) {
  return TRUSTED_OWNERS.has(ownerSid(target));
}

/**
 * The data directory lives under C:\ProgramData, where any local user may create folders.
 * Someone could pre-create it with a configuration of their own (their server, their
 * password key) hoping the administrator's installation will adopt it. Whoever owns an
 * object can always rewrite its permissions, so ownership, not the current ACL, decides:
 * anything not owned by SYSTEM or Administrators is thrown away.
 */
export function discardUntrustedData(dir, report = []) {
  if (!fs.existsSync(dir)) return report;
  if (!isTrustedOwner(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    report.push(`Dossier ${dir} préexistant, créé par un utilisateur non administrateur : supprimé puis recréé.`);
    return report;
  }
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!isTrustedOwner(full)) {
      fs.rmSync(full, { recursive: true, force: true });
      report.push(`Fichier non fiable supprimé : ${name}`);
    }
  }
  return report;
}

function scQuery() {
  const r = spawnSync('sc.exe', ['query', SERVICE_NAME], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = /STATE\s*:\s*\d+\s+(\w+)/.exec(r.stdout);
  return m ? m[1] : 'UNKNOWN';
}

function waitForState(state, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = scQuery();
    if (s === state || s === null) return s;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  }
  return scQuery();
}

function requireElevation(action) {
  if (!isElevated()) {
    throw new Error(
      `"service ${action}" modifie le système et demande les droits administrateur.\n` +
        'Ouvrez PowerShell en tant qu\'administrateur (clic droit > Exécuter en tant qu\'administrateur) puis relancez :\n' +
        `  node "${path.join(REPO_ROOT, 'agent', 'agent.js')}" service ${action}`,
    );
  }
}

/** @returns {string[]} human-readable report lines */
export function installService({ server, userConfigFile } = {}) {
  requireElevation('install');
  const report = [];
  const dest = installDir();
  const data = serviceDataDir();

  if (scQuery() !== null) {
    try {
      run('sc.exe', ['stop', SERVICE_NAME]);
    } catch {
      /* already stopped */
    }
    waitForState('STOPPED');
  }

  // 1. Program files in an admin-only location, with a private copy of the Node runtime.
  //    %ProgramFiles% only lets administrators write; /reset makes every copied file inherit it.
  stageFiles({ destDir: dest, nodeExe: process.execPath });
  buildServiceExe({ outFile: path.join(dest, 'BifrostService.exe') });
  // H.264 capture helper, built here so that it lives in the protected directory.
  buildCaptureExe({ outFile: path.join(dest, 'agent', 'bin', 'BifrostCapture.exe') });
  run('icacls.exe', [dest, '/T', '/C', '/Q', '/reset']);
  report.push(`Programme installé dans ${dest} (modifiable par les administrateurs uniquement).`);

  // 2. Private data directory: the secret and the password key must not be readable by users,
  //    and nothing pre-seeded by an unprivileged user may be adopted.
  discardUntrustedData(data, report);
  fs.mkdirSync(data, { recursive: true });
  icacls(data, `${SYSTEM}:(OI)(CI)F`, `${ADMINS}:(OI)(CI)F`, `${USERS}:(RX)`);
  const svcFile = path.join(data, 'agent.json');
  let cfg = loadConfig(svcFile);
  if (!cfg.secret) {
    const user = loadConfig(userConfigFile);
    cfg = {};
    for (const k of ['server', 'id', 'secret', 'passwordSalt', 'passwordIters', 'passwordKey', 'requireConsent']) {
      if (user[k] !== undefined) cfg[k] = user[k];
    }
  }
  if (server) cfg.server = normalizeServerUrl(server);
  cfg.server ??= 'ws://localhost:7780/ws';
  fs.writeFileSync(path.join(data, 'public.json'), JSON.stringify({}));
  run('icacls.exe', [path.join(data, 'public.json'), '/grant', `${USERS}:R`, '/Q']);
  saveConfig(cfg, svcFile);
  // File drop box. The service writes here as SYSTEM, so ordinary users get read-only access:
  // they can collect what was sent but cannot plant junctions or swap files under the service.
  const inbox = path.join(data, 'Transfers', 'Inbox');
  fs.mkdirSync(inbox, { recursive: true });
  icacls(path.join(data, 'Transfers'), `${SYSTEM}:(OI)(CI)F`, `${ADMINS}:(OI)(CI)F`, `${USERS}:(OI)(CI)RX`);
  report.push(`Dossier de dépôt des fichiers reçus : ${inbox} (lecture seule pour les utilisateurs).`);
  report.push(`Configuration du service : ${svcFile}`);
  report.push(`Serveur : ${cfg.server}`);
  report.push(
    cfg.passwordKey
      ? 'Mot de passe : défini (accès sans surveillance possible).'
      : 'Mot de passe : AUCUN. Sans mot de passe, personne ne peut accepter une connexion avant l\'ouverture de session. ' +
          'Définissez-en un avec : node agent/agent.js set-password --service (en administrateur), puis redémarrez le service.',
  );

  // 3. Register and start the service.
  const exe = path.join(dest, 'BifrostService.exe');
  if (scQuery() !== null) {
    run('sc.exe', ['config', SERVICE_NAME, 'binPath=', `"${exe}"`, 'start=', 'auto'], { windowsVerbatimArguments: true });
  } else {
    run(
      'sc.exe',
      ['create', SERVICE_NAME, 'binPath=', `"${exe}"`, 'start=', 'auto', 'DisplayName=', '"Bifrost Remote Agent"'],
      { windowsVerbatimArguments: true },
    );
  }
  run('sc.exe', ['description', SERVICE_NAME, '"Prise en main a distance Bifrost (agent hote, demarre avec Windows)."'], {
    windowsVerbatimArguments: true,
  });
  run('sc.exe', ['failure', SERVICE_NAME, 'reset=', '86400', 'actions=', 'restart/5000/restart/5000/restart/30000']);
  run('sc.exe', ['start', SERVICE_NAME]);
  report.push(`Service "${SERVICE_NAME}" créé, démarrage automatique, démarré. Visible dans services.msc.`);
  return report;
}

export function uninstallService({ purge = false } = {}) {
  requireElevation('uninstall');
  const report = [];
  if (scQuery() !== null) {
    run('sc.exe', ['stop', SERVICE_NAME]);
    waitForState('STOPPED');
    run('sc.exe', ['delete', SERVICE_NAME]);
    report.push('Service arrêté et supprimé.');
  } else {
    report.push('Aucun service installé.');
  }
  fs.rmSync(installDir(), { recursive: true, force: true });
  report.push(`Fichiers supprimés : ${installDir()}`);
  if (purge) {
    fs.rmSync(serviceDataDir(), { recursive: true, force: true });
    report.push(`Configuration et identifiant supprimés : ${serviceDataDir()}`);
  } else {
    report.push(`Configuration conservée dans ${serviceDataDir()} (--purge pour la supprimer).`);
  }
  return report;
}

export function controlService(action) {
  requireElevation(action);
  run('sc.exe', [action, SERVICE_NAME]);
  return [`Service ${action === 'start' ? 'démarré' : 'arrêté'}.`];
}

export function serviceStatus() {
  const state = scQuery();
  const lines = [`Service ${SERVICE_NAME} : ${state ?? 'non installé'}`];
  try {
    const pub = JSON.parse(fs.readFileSync(path.join(serviceDataDir(), 'public.json'), 'utf8'));
    if (pub.id) lines.push(`Identifiant : ${pub.id.replace(/(\d{3})(?=\d)/g, '$1 ')}`);
    if (pub.server) lines.push(`Serveur : ${pub.server}`);
  } catch {
    /* not installed or never started */
  }
  return lines;
}

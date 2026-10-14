#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { formatId } from '../shared/auth.js';
import {
  clearPassword,
  configPath,
  ensureIdentity,
  loadConfig,
  normalizeServerUrl,
  saveConfig,
  serviceDataDir,
  setPassword,
} from './config.js';
import { createWindowsHelpers } from './helpers.js';
import { buildPermissions, describePermissions } from './permissions.js';
import { startHost } from './host.js';

const MIN_PASSWORD_LENGTH = 12;
const LOG_MAX_BYTES = 5 * 1024 * 1024;

const USAGE = `Bifrost agent

  node agent/agent.js [run]              Lancer l'agent (par defaut)
  node agent/agent.js id                 Afficher l'identifiant de ce PC
  node agent/agent.js set-password       Definir le mot de passe d'acces sans surveillance
  node agent/agent.js clear-password     Supprimer ce mot de passe

Permissions de ce PC (ce qu'une personne a distance a le droit de faire en plus de voir/controler) :
  node agent/agent.js permissions                          Afficher
  node agent/agent.js permissions --clipboard on|off       Presse-papiers (texte)
  node agent/agent.js permissions --files ask|allow|deny   Transfert de fichiers (ask = demander a chaque fois)
  node agent/agent.js permissions --share <dossier> [--share-name <nom>] [--share-write]
  node agent/agent.js permissions --unshare <nom>          Retirer un dossier partage

Service Windows (demarre avec Windows, voit l'ecran de connexion et les fenetres UAC) :
  node agent/agent.js service install    Installer et demarrer  (PowerShell en administrateur)
  node agent/agent.js service status     Etat du service et identifiant
  node agent/agent.js service start|stop Demarrer / arreter       (administrateur)
  node agent/agent.js service uninstall [--purge]   Desinstaller  (administrateur)
  node agent/agent.js set-password --service        Mot de passe du service (administrateur)

Options :
  --server <url>        Serveur Bifrost (memorise), ex. wss://bifrost.exemple.fr
  --require-consent     Toujours demander l'accord, meme avec le mot de passe
  --no-require-consent  Accepter directement quand le mot de passe est correct
  --service             Utiliser la configuration du service (ProgramData)
  --config <fichier>    Fichier de configuration explicite
  --log <fichier>       Ecrire le journal dans un fichier (rotation a 5 Mo)
`;

const VALUE_OPTIONS = new Set(['--server', '--config', '--log', '--clipboard', '--files', '--share', '--share-name', '--unshare']);

function parseArgs(argv) {
  const positional = [];
  const flags = new Set();
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_OPTIONS.has(a)) values[a] = argv[++i];
    else if (a.startsWith('--')) flags.add(a);
    else positional.push(a);
  }
  return { positional, flags, values };
}

function makeLogger(file) {
  if (!file) return (m) => console.log(`${new Date().toLocaleTimeString()} ${m}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return (m) => {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX_BYTES) {
        fs.rmSync(`${file}.1`, { force: true });
        fs.renameSync(file, `${file}.1`);
      }
      fs.appendFileSync(file, `${new Date().toISOString()} ${m}\n`);
    } catch {
      /* logging must never crash the agent */
    }
  };
}

function readHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    let value = '';
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const { positional, flags, values } = parseArgs(process.argv.slice(2));
  const command = positional[0] ?? 'run';
  if (flags.has('--help') || command === 'help') return console.log(USAGE);

  if (command === 'service') {
    const service = await import('./service.js');
    const sub = positional[1];
    let lines;
    if (sub === 'install') lines = service.installService({ server: values['--server'] });
    else if (sub === 'uninstall') lines = service.uninstallService({ purge: flags.has('--purge') });
    else if (sub === 'start' || sub === 'stop') lines = service.controlService(sub);
    else if (sub === 'status') lines = service.serviceStatus();
    else return console.log(USAGE);
    return console.log(lines.join('\n'));
  }

  const serviceMode = flags.has('--service');
  const cfgFile = values['--config'] ?? (serviceMode ? path.join(serviceDataDir(), 'agent.json') : configPath());
  const log = makeLogger(
    values['--log'] ?? (serviceMode && command === 'run' ? path.join(path.dirname(cfgFile), 'agent.log') : null),
  );

  const cfg = loadConfig(cfgFile);
  const before = JSON.stringify(cfg);
  await ensureIdentity(cfg);
  if (values['--server']) cfg.server = normalizeServerUrl(values['--server']);
  if (flags.has('--require-consent')) cfg.requireConsent = true;
  if (flags.has('--no-require-consent')) cfg.requireConsent = false;
  cfg.server ??= 'ws://localhost:7780/ws';
  // Rewriting an unchanged file would reset its permissions in service mode: only write on change.
  if (JSON.stringify(cfg) !== before) saveConfig(cfg, cfgFile);

  if (command === 'id') {
    console.log(`Identifiant : ${formatId(cfg.id)}\nServeur     : ${cfg.server}\nConfig      : ${cfgFile}`);
    return;
  }
  if (command === 'set-password') {
    const p1 = await readHidden(`Nouveau mot de passe (${MIN_PASSWORD_LENGTH} caracteres minimum) : `);
    if (p1.length < MIN_PASSWORD_LENGTH) throw new Error(`Mot de passe trop court (${MIN_PASSWORD_LENGTH} caracteres minimum).`);
    const p2 = await readHidden('Confirmer : ');
    if (p1 !== p2) throw new Error('Les mots de passe different.');
    await setPassword(cfg, p1);
    saveConfig(cfg, cfgFile);
    console.log('Mot de passe enregistre (seule une cle derivee est stockee).');
    if (serviceMode) console.log('Redemarrez le service pour l\'appliquer : node agent/agent.js service stop, puis start.');
    return;
  }
  if (command === 'permissions') {
    if (values['--clipboard']) {
      if (!['on', 'off'].includes(values['--clipboard'])) throw new Error('--clipboard on|off');
      cfg.clipboard = values['--clipboard'] === 'on';
    }
    if (values['--files']) {
      if (!['ask', 'allow', 'deny'].includes(values['--files'])) throw new Error('--files ask|allow|deny');
      cfg.fileTransfer = values['--files'];
    }
    if (values['--share']) {
      const dir = path.resolve(values['--share']);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Dossier introuvable : ${dir}`);
      const name = (values['--share-name'] ?? path.basename(dir)).replace(/[^\p{L}\p{N} ._-]/gu, '_').slice(0, 40) || 'Partage';
      if (['Inbox', 'Outbox'].includes(name)) throw new Error('Ce nom est reserve.');
      cfg.shares = [...(cfg.shares ?? []).filter((s) => s.name !== name), { name, dir, write: flags.has('--share-write') }];
    }
    if (values['--unshare']) cfg.shares = (cfg.shares ?? []).filter((s) => s.name !== values['--unshare']);
    saveConfig(cfg, cfgFile);
    console.log(describePermissions(cfg, serviceMode, path.dirname(cfgFile)));
    return;
  }
  if (command === 'clear-password') {
    clearPassword(cfg);
    saveConfig(cfg, cfgFile);
    console.log('Mot de passe supprime : chaque connexion demandera votre accord.');
    return;
  }
  if (command !== 'run') return console.log(USAGE);

  if (process.platform !== 'win32') throw new Error('L\'agent hote ne gere que Windows pour l\'instant.');
  if (serviceMode) {
    // Lets non-admin users read the ID/server (the secret stays in the protected agent.json).
    try {
      fs.writeFileSync(path.join(path.dirname(cfgFile), 'public.json'), JSON.stringify({ id: cfg.id, server: cfg.server }));
    } catch {
      /* best effort */
    }
  }
  await run(cfg, log, { serviceMode, cfgFile });
}

async function run(cfg, log, { serviceMode, cfgFile }) {
  const host = startHost({ cfg, cfgFile, helpers: createWindowsHelpers(log), serviceMode, log });
  const shutdown = () => {
    host.stop();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

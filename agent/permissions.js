import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serviceDataDir } from './config.js';

/**
 * What the owner of this PC allows a remote person to do besides seeing/controlling the screen.
 * Files are limited to declared folders: a default drop box and a default outbox, plus any
 * folder added with "permissions --share". As a SYSTEM service, only the drop box exists and it
 * is write-only: nothing a normal user can plant (junctions...) is ever read with SYSTEM rights.
 *
 * Nothing is created on disk here. ensureDirs() is called by a session only once a remote person
 * has been accepted with file transfer enabled: pairing alone must have no effect on the PC.
 */
export function buildPermissions(cfg, { serviceMode = false, baseDir = null, log = () => {} } = {}) {
  const base =
    cfg.transferDir ??
    (serviceMode ? path.join(baseDir ?? serviceDataDir(), 'Transfers') : path.join(os.homedir(), 'Bifrost Transfers'));
  const defaults = [{ name: 'Inbox', dir: path.join(base, 'Inbox'), read: !serviceMode, write: true }];
  if (!serviceMode) defaults.push({ name: 'Outbox', dir: path.join(base, 'Outbox'), read: true, write: false });
  const roots = [...defaults];
  if (!serviceMode) {
    for (const s of cfg.shares ?? []) {
      if (s && typeof s.name === 'string' && typeof s.dir === 'string' && fs.existsSync(s.dir)) {
        roots.push({ name: s.name, dir: s.dir, read: true, write: Boolean(s.write) });
      }
    }
  }
  return {
    clipboard: cfg.clipboard !== false,
    // the assistant of the person in control (only offered by the desktop app, and only in control mode)
    assistant: cfg.assistant !== false,
    fileTransfer: ['ask', 'allow', 'deny'].includes(cfg.fileTransfer) ? cfg.fileTransfer : 'ask',
    roots,
    maxFileBytes: cfg.maxFileBytes,
    ensureDirs() {
      for (const r of defaults) {
        try {
          fs.mkdirSync(r.dir, { recursive: true });
        } catch (err) {
          log(`dossier partage indisponible (${r.name}) : ${err.message}`);
        }
      }
    },
  };
}
export function describePermissions(cfg, serviceMode, baseDir = null) {
  const p = buildPermissions(cfg, { serviceMode, baseDir: baseDir ?? undefined });
  const lines = [
    `Presse-papiers : ${p.clipboard ? 'autorise' : 'desactive'}`,
    `Transfert de fichiers : ${p.fileTransfer === 'ask' ? 'autorise, avec votre accord a chaque fichier' : p.fileTransfer === 'allow' ? 'autorise sans demander' : 'desactive'}`,
    'Dossiers partages :',
    ...p.roots.map((r) => `  /${r.name}  ${r.dir}  (${r.read ? 'lecture' : ''}${r.read && r.write ? ' + ' : ''}${r.write ? 'depot' : ''})`),
  ];
  if (serviceMode) lines.push('  (service SYSTEM : dossier de depot seulement, aucun autre dossier ne peut etre partage)');
  return lines.join('\n');
}

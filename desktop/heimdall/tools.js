// Heimdall: what the assistant can actually do on this PC. A fixed list of tools: the model
// can never run anything that is not described here. Read-only tools run directly; anything that
// changes the machine carries a `confirm` text, shown to the person in a native dialog of the
// main process (the model and the web page cannot answer it).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const MAX_OUTPUT = 6000;
const DAY = 24 * 60 * 60 * 1000;

const clip = (text) => {
  const s = String(text ?? '').trim();
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n… (sortie tronquée)` : s;
};

const ps = (script) => [
  'powershell.exe',
  ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(`[Console]::OutputEncoding=[Text.Encoding]::UTF8;$ErrorActionPreference='Stop';${script}`, 'utf16le').toString('base64')],
];

/** Real process runner: resolves { code, stdout, stderr } and never throws. */
export function runProcess(file, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout ?? '', stderr: stderr || (err && !stdout ? err.message : '') });
    });
  });
}

const fmt = ({ code, stdout, stderr }) =>
  code === 0 ? clip(stdout) || 'Terminé.' : `Échec (code ${code}).\n${clip(stderr || stdout)}`;

/**
 * @param {object} o
 * @param {NodeJS.Platform} [o.platform]
 * @param {(file:string,args:string[],opts?:object)=>Promise<{code:number,stdout:string,stderr:string}>} [o.run]
 * @param {object} [o.sys]  os/fs facade, replaceable in tests
 */
export function createTools({ platform = process.platform, run = runProcess, sys = {} } = {}) {
  const osApi = sys.os ?? os;
  const fsApi = sys.fs ?? fs;
  const win = platform === 'win32';
  const mac = platform === 'darwin';

  const tools = [
    {
      name: 'system_info',
      description: 'Informations sur cet ordinateur : système, processeur, mémoire, durée depuis le démarrage.',
      parameters: { type: 'object', properties: {} },
      async run() {
        const gb = (n) => `${(n / 1024 ** 3).toFixed(1)} Go`;
        const up = osApi.uptime();
        return [
          `Nom : ${osApi.hostname()}`,
          `Système : ${osApi.type()} ${osApi.release()} (${osApi.arch()})`,
          `Processeur : ${osApi.cpus()[0]?.model ?? 'inconnu'} (${osApi.cpus().length} cœurs)`,
          `Mémoire : ${gb(osApi.totalmem() - osApi.freemem())} utilisés sur ${gb(osApi.totalmem())}`,
          `Allumé depuis : ${Math.floor(up / 3600)} h ${Math.floor((up % 3600) / 60)} min`,
        ].join('\n');
      },
    },
    {
      name: 'disk_usage',
      description: 'Espace libre et utilisé sur les disques.',
      parameters: { type: 'object', properties: {} },
      async run() {
        if (win) {
          return fmt(await run(...ps("Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | ForEach-Object { '{0}: {1:N1} Go utilisés, {2:N1} Go libres' -f $_.Name, ($_.Used/1GB), ($_.Free/1GB) }")));
        }
        return fmt(await run('df', ['-h', '-P']));
      },
    },
    {
      name: 'top_processes',
      description: 'Les 10 processus qui consomment le plus de processeur / mémoire.',
      parameters: { type: 'object', properties: {} },
      async run() {
        if (win) {
          return fmt(await run(...ps("Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10 | ForEach-Object { '{0} (pid {1}) : {2:N0} Mo' -f $_.ProcessName, $_.Id, ($_.WorkingSet64/1MB) }")));
        }
        const r = await run('ps', mac ? ['-Ao', 'pid,comm,%cpu,%mem', '-r'] : ['-eo', 'pid,comm,%cpu,%mem', '--sort=-%cpu']);
        return fmt({ ...r, stdout: r.stdout.split('\n').slice(0, 11).join('\n') });
      },
    },
    {
      name: 'check_updates',
      description: win
        ? 'Vérifie les mises à jour Windows en attente (ne les installe pas).'
        : 'Vérifie les mises à jour système en attente (ne les installe pas).',
      parameters: { type: 'object', properties: {} },
      async run() {
        if (win) {
          return fmt(
            await run(
              ...ps(
                "$r=(New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher().Search('IsInstalled=0 and IsHidden=0'); " +
                  "if ($r.Updates.Count -eq 0) { 'Windows est à jour : aucune mise à jour en attente.' } else { \"$($r.Updates.Count) mise(s) à jour en attente :\"; $r.Updates | ForEach-Object { '- ' + $_.Title } }",
              ),
              { timeoutMs: 180_000 },
            ),
          );
        }
        if (mac) return fmt(await run('softwareupdate', ['-l'], { timeoutMs: 180_000 }));
        const apt = await run('sh', ['-c', 'command -v apt >/dev/null && apt list --upgradable 2>/dev/null']);
        if (apt.code === 0 && apt.stdout.trim()) return fmt(apt);
        const dnf = await run('sh', ['-c', 'command -v dnf >/dev/null && dnf -q check-update']);
        if (dnf.stdout.trim()) return fmt({ ...dnf, code: 0 });
        const pac = await run('sh', ['-c', 'command -v checkupdates >/dev/null && checkupdates']);
        if (pac.stdout.trim()) return fmt({ ...pac, code: 0 });
        return 'Aucune mise à jour en attente détectée (apt, dnf, pacman).';
      },
    },
    {
      name: 'empty_trash',
      description: win ? 'Vide la corbeille de cet ordinateur.' : 'Vide la corbeille de cet utilisateur.',
      parameters: { type: 'object', properties: {} },
      confirm: () => 'Vider définitivement la corbeille de cet ordinateur.',
      async run() {
        if (win) return fmt(await run(...ps("Clear-RecycleBin -Force -ErrorAction SilentlyContinue; 'Corbeille vidée.'")));
        if (mac) return fmt(await run('osascript', ['-e', 'tell application "Finder" to empty trash']));
        const r = await run('gio', ['trash', '--empty']);
        return r.code === 0 ? 'Corbeille vidée.' : fmt(r);
      },
    },
    {
      name: 'clean_temp_files',
      description: 'Supprime les fichiers et dossiers temporaires de plus de 2 jours dans le dossier temporaire de l’utilisateur.',
      parameters: { type: 'object', properties: {} },
      confirm: () => `Supprimer les éléments de plus de 2 jours dans ${osApi.tmpdir()}.`,
      async run() {
        const dir = osApi.tmpdir();
        let removed = 0;
        let kept = 0;
        for (const name of fsApi.readdirSync(dir)) {
          const full = path.join(dir, name);
          try {
            const st = fsApi.lstatSync(full);
            if (Date.now() - st.mtimeMs < 2 * DAY) continue;
            fsApi.rmSync(full, { recursive: true, force: true });
            removed += 1;
          } catch {
            kept += 1; // in use or protected
          }
        }
        return `${removed} élément(s) supprimé(s), ${kept} ignoré(s) (en cours d’utilisation).`;
      },
    },
    {
      name: 'run_command',
      description:
        `Exécute une commande ${win ? 'PowerShell' : 'shell'} sur ce PC et renvoie sa sortie. À n'utiliser que si aucun autre outil ne convient. ` +
        'La personne devra confirmer en voyant la commande exacte.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'La commande à exécuter.' } },
        required: ['command'],
      },
      confirm: (args) => `Exécuter cette commande :\n\n${String(args?.command ?? '').slice(0, 800)}`,
      async run(args) {
        const command = String(args?.command ?? '').trim();
        if (!command) return 'Commande vide.';
        if (win) return fmt(await run(...ps(command), { timeoutMs: 60_000 }));
        return fmt(await run('sh', ['-c', command], { timeoutMs: 60_000 }));
      },
    },
  ];

  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    list: tools,
    /** Definitions for the model (no executors). */
    definitions: () => tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    get: (name) => byName.get(name),
  };
}

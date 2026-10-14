import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FrameParser } from './frames.js';
import { resolveCaptureExe } from './native-build.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
// -Sta: the Windows Forms clipboard (and dialogs) require a single-threaded apartment.
const PS_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-File'];

function ps(script, args = [], opts = {}) {
  return spawn('powershell.exe', [...PS_ARGS, path.join(DIR, script), ...args], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
}

function drain(child, log, name) {
  child.stderr.on('data', (d) => log(`[${name}] ${d.toString().trim()}`));
  child.on('error', (err) => log(`[${name}] spawn error: ${err.message}`));
}

const RECORD_HEADER = 10;
const MAX_MONITORS = 16;

/**
 * The native helper's monitor report -> { current, list: [{ x, y, w, h, primary }] }, or null
 * when it is not what we expect. Index 0 is always the primary monitor.
 */
export function parseMonitorReport(text) {
  try {
    const raw = JSON.parse(text);
    const int = (n) => Number.isInteger(n) && Math.abs(n) < 1_000_000;
    if (!raw || !Array.isArray(raw.list) || raw.list.length === 0 || raw.list.length > MAX_MONITORS) return null;
    const list = raw.list.map((m) => ({ x: m?.x, y: m?.y, w: m?.w, h: m?.h, primary: m?.p === 1 }));
    if (!list.every((m) => int(m.x) && int(m.y) && int(m.w) && int(m.h) && m.w > 0 && m.h > 0)) return null;
    const current = Number.isInteger(raw.current) && raw.current >= 0 && raw.current < list.length ? raw.current : 0;
    return { current, list };
  } catch {
    return null;
  }
}

/**
 * Parses BifrostCapture.exe stdout:
 * [type u8][flags u8][width u16 BE][height u16 BE][length u32 BE][payload]
 */
export class RecordParser {
  constructor({ onStatus, onFrame, onMonitors }) {
    this.onStatus = onStatus;
    this.onFrame = onFrame;
    this.onMonitors = onMonitors;
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= RECORD_HEADER) {
      const length = this.buf.readUInt32BE(6);
      if (length > 32 * 1024 * 1024) throw new Error(`corrupt record length ${length}`);
      if (this.buf.length < RECORD_HEADER + length) break;
      const type = this.buf[0];
      const flags = this.buf[1];
      const width = this.buf.readUInt16BE(2);
      const height = this.buf.readUInt16BE(4);
      const payload = this.buf.subarray(RECORD_HEADER, RECORD_HEADER + length);
      if (type === 0) this.onStatus(payload.toString('ascii'));
      else if (type === 1) this.onFrame({ kind: 'jpeg', key: true, width, height, data: payload });
      else if (type === 2) this.onFrame({ kind: 'h264', key: (flags & 1) === 1, width, height, data: payload });
      else if (type === 3) {
        const report = parseMonitorReport(payload.toString('utf8'));
        if (report) this.onMonitors?.(report);
      }
      this.buf = this.buf.subarray(RECORD_HEADER + length);
    }
  }
}

/** Real (Windows) implementations of what a Session needs from the OS. */
export function createWindowsHelpers(log = () => {}) {
  let captureExe; // undefined = not resolved yet, null = unavailable
  const exe = () => {
    if (captureExe === undefined) captureExe = resolveCaptureExe(DIR, log);
    return captureExe;
  };

  return {
    /**
     * Starts screen capture. onFrame({kind:'h264'|'jpeg', key, width, height, data}).
     * `monitor` is the index into the list reported through onMonitors({ current, list }),
     * 0 = primary; only the native helper can capture another monitor.
     * Returns { stop, requestKeyframe, setBitrate, setMonitor, codec }.
     */
    startCapture({ codec = 'h264', fps = 30, bitrate = 4_000_000, maxWidth = 1920, quality = 55, monitor = 0, onFrame, onMonitors, onExit }) {
      let native = exe();
      let child = null;
      let actual = 'jpeg';
      let stopped = false;

      const wire = (c) => {
        drain(c, log, 'capture');
        c.stdin?.on('error', () => {});
        c.on('exit', (code) => {
          if (c === child && !stopped) onExit?.(code);
        });
      };
      const feed = (c, parser) =>
        c.stdout.on('data', (chunk) => {
          try {
            parser.push(chunk);
          } catch (err) {
            log(`[capture] ${err.message}`);
            c.kill();
          }
        });

      // No native helper (no csc.exe) or it could not start: the PowerShell grabber, JPEG only.
      const launchPowerShell = () => {
        actual = 'jpeg';
        const c = ps('capture.ps1', ['-Fps', String(Math.min(fps, 10)), '-Quality', String(quality), '-MaxWidth', String(Math.min(maxWidth, 1600))]);
        child = c;
        feed(c, new FrameParser((width, height, jpeg) => onFrame({ kind: 'jpeg', key: true, width, height, data: jpeg })));
        wire(c);
      };

      const launchNative = () => {
        let c;
        try {
          c = spawn(
            native,
            [
              '--codec', codec, '--fps', String(fps), '--bitrate', String(bitrate), '--maxwidth', String(maxWidth),
              '--quality', String(quality), '--monitor', String(Number.isInteger(monitor) && monitor >= 0 ? monitor : 0),
            ],
            { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
          );
        } catch (err) {
          // e.g. "spawn UNKNOWN": the file is still locked by a scanner, or blocked by policy
          log(`[capture] assistant natif non demarre (${err.message}), repli sur PowerShell`);
          native = null;
          launchPowerShell();
          return;
        }
        child = c;
        feed(
          c,
          new RecordParser({
            onStatus: (s) => {
              if (s === 'h264' || s === 'jpeg') actual = s;
              log(`[capture] codec ${s}`);
              if (s.startsWith('error')) c.kill();
            },
            onFrame,
            onMonitors,
          }),
        );
        c.on('error', (err) => {
          if (stopped || c !== child) return;
          log(`[capture] assistant natif non demarre (${err.message}), repli sur PowerShell`);
          native = null;
          launchPowerShell();
        });
        wire(c);
      };

      if (native) launchNative();
      else launchPowerShell();

      const command = (line) => native && child?.stdin?.writable && child.stdin.write(`${line}\n`);
      return {
        stop: () => {
          stopped = true;
          child?.kill();
        },
        requestKeyframe: () => command('K'),
        setBitrate: (bps) => command(`B ${Math.round(bps)}`),
        setMonitor: (index) => Number.isInteger(index) && index >= 0 && command(`M ${index}`),
        get codec() {
          return actual;
        },
      };
    },
    /** Starts the input injector. Returns { send(line), stop }. */
    startInput({ dryRun = false } = {}) {
      const child = ps('input.ps1', dryRun ? ['-DryRun'] : []);
      drain(child, log, 'input');
      child.stdout.resume();
      child.stdin.on('error', () => {});
      return {
        send: (line) => child.stdin.writable && child.stdin.write(`${line}\n`),
        stop: () => child.kill(),
      };
    },

    /**
     * Text clipboard bridge. onChange(text) fires when the clipboard text changes (not for
     * changes made through set()). Returns { set(text), stop }.
     */
    startClipboard({ onChange, onSet = () => {} }) {
      const child = ps('clipboard.ps1');
      drain(child, log, 'clipboard');
      child.stdin.on('error', () => {});
      let buffered = '';
      child.stdout.on('data', (d) => {
        buffered += d.toString('utf8');
        let nl;
        while ((nl = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, nl).trim();
          buffered = buffered.slice(nl + 1);
          if (line.startsWith('A ')) onSet(line === 'A ok');
          else if (line.startsWith('C ')) {
            try {
              onChange(Buffer.from(line.slice(2), 'base64').toString('utf8'));
            } catch {
              /* malformed line */
            }
          }
        }
      });
      return {
        set: (text) => child.stdin.writable && child.stdin.write(`S ${Buffer.from(text, 'utf8').toString('base64')}\n`),
        stop: () => child.kill(),
      };
    },

    /** Shows a topmost banner for the whole session. onStop fires if the user clicks Stop. */
    showIndicator({ text, stopLabel, onStop }) {
      const child = ps('indicator.ps1', ['-Text', text, '-StopLabel', stopLabel, '-ParentPid', String(process.pid)]);
      drain(child, log, 'indicator');
      let out = '';
      child.stdout.on('data', (d) => {
        out += d.toString();
        if (out.includes('STOP')) onStop();
      });
      return { stop: () => child.kill() };
    },

    /** Asks the person at the PC. Resolves true only on an explicit "Yes". */
    askConsent({ text, title, timeoutMs = 30_000 }) {
      const child = ps('consent.ps1', ['-Text', text, '-Title', title]);
      drain(child, log, 'consent');
      let out = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      let timer;
      const promise = new Promise((resolve) => {
        timer = setTimeout(() => {
          child.kill();
          resolve(false);
        }, timeoutMs);
        child.on('exit', () => {
          clearTimeout(timer);
          resolve(out.trim() === 'YES');
        });
        child.on('error', () => resolve(false));
      });
      return { promise, cancel: () => { clearTimeout(timer); child.kill(); } };
    },
  };
}

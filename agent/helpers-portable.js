// OS helpers for macOS and Linux (and for Windows when BIFROST_PORTABLE=1, to test this path).
// They only exist inside the desktop app: screen capture and the clipboard come from Electron.
//   capture   : { startCapture(opts) } supplied by desktop/capture-electron.mjs
//   clipboard : Electron's clipboard module ({ readText, writeText })
import { createPortableInput } from './input-portable.js';

const CLIPBOARD_POLL_MS = 500;
const MAX_CLIPBOARD_BYTES = 1024 * 1024;

export function createPortableHelpers({ log = () => {}, capture, clipboard, platform = process.platform, createInput = createPortableInput }) {
  return {
    startCapture: (opts) => capture.startCapture(opts),

    startInput() {
      const input = createInput({ platform, log });
      return { send: (line) => input.send(line), stop: () => input.stop() };
    },

    /** Same contract as the Windows helper: set(text) / stop(); onChange(text) on local changes. */
    startClipboard({ onChange, onSet = () => {} }) {
      const read = () => {
        try {
          return clipboard.readText();
        } catch {
          return null;
        }
      };
      let last = read();
      const timer = setInterval(() => {
        const now = read();
        if (typeof now !== 'string' || now === last) return;
        last = now;
        if (now && Buffer.byteLength(now) <= MAX_CLIPBOARD_BYTES) onChange(now);
      }, CLIPBOARD_POLL_MS);
      timer.unref?.();
      return {
        set(text) {
          try {
            clipboard.writeText(text);
            last = text; // our own write is not a change to forward back
            onSet(true);
          } catch {
            onSet(false);
          }
        },
        stop: () => clearInterval(timer),
      };
    },
  };
}

// Screen capture through Electron (all platforms): a hidden window gets the chosen screen with
// getDisplayMedia, paints it into a canvas and sends JPEG frames back to the main process.
// Frames are JPEG only (no H.264 encoder here); the pointer is part of the captured picture.
import path from 'node:path';

/**
 * @param {object} o
 * @param {typeof import('electron')} o.electron
 * @param {string} o.desktopDir  the desktop/ folder
 * @param {NodeJS.Platform} [o.platform]
 */
export function createElectronCapture({ electron, desktopDir, platform = process.platform, log = () => {} }) {
  const { BrowserWindow, desktopCapturer, screen, ipcMain, session } = electron;

  /** Displays in the order the viewer lists them (primary first), in the pixel space of the input helper. */
  function listDisplays() {
    const primary = screen.getPrimaryDisplay().id;
    const all = screen.getAllDisplays().sort((a, b) => (b.id === primary) - (a.id === primary));
    return all.map((d) => {
      let b = d.bounds;
      if (platform === 'win32' && typeof screen.dipToScreenRect === 'function') b = screen.dipToScreenRect(null, d.bounds);
      else if (platform === 'linux') b = { x: d.bounds.x * d.scaleFactor, y: d.bounds.y * d.scaleFactor, width: d.bounds.width * d.scaleFactor, height: d.bounds.height * d.scaleFactor };
      return { id: d.id, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), primary: d.id === primary };
    });
  }

  let chosenSource = null;
  let handlerInstalled = false;
  const installHandler = () => {
    if (handlerInstalled) return;
    handlerInstalled = true;
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      if (chosenSource) callback({ video: chosenSource });
      else callback({});
    });
  };

  return {
    listDisplays,

    startCapture({ fps = 15, maxWidth = 1920, quality = 55, monitor = 0, onFrame, onMonitors, onExit }) {
      installHandler();
      let stopped = false;
      let current = Number.isInteger(monitor) && monitor >= 0 ? monitor : 0;
      let win = null;
      let displays = listDisplays();
      if (current >= displays.length) current = 0;

      const report = () => {
        displays = listDisplays();
        if (current >= displays.length) current = 0;
        onMonitors?.({ current, list: displays.map(({ x, y, w, h, primary }) => ({ x, y, w, h, primary })) });
      };

      async function pickSource() {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
        const d = displays[current];
        return sources.find((s) => s.display_id === String(d.id)) ?? sources[current] ?? sources[0] ?? null;
      }

      async function begin() {
        const source = await pickSource();
        if (!source) throw new Error('aucun écran disponible');
        chosenSource = source;
        if (!win || win.isDestroyed()) {
          win = new BrowserWindow({
            show: false,
            width: 320,
            height: 200,
            webPreferences: {
              preload: path.join(desktopDir, 'preload-capture.cjs'),
              contextIsolation: true,
              sandbox: true,
              nodeIntegration: false,
              backgroundThrottling: false,
            },
          });
          win.__bifrostUi = false;
          win.__bifrostCapture = true;
          win.on('closed', () => {
            win = null;
            if (!stopped) onExit?.(1);
          });
          await win.loadURL('bifrost://ui/capture.html');
        }
        // userGesture=true: getDisplayMedia refuses to start without one
        await win.webContents.executeJavaScript(
          `window.__bifrostCaptureStart(${JSON.stringify({ fps, maxWidth, quality })})`,
          true,
        );
      }

      const onFrameMsg = (e, width, height, data) => {
        if (stopped || !win || e.sender !== win.webContents) return;
        if (!Number.isInteger(width) || !Number.isInteger(height) || !data) return;
        onFrame({ kind: 'jpeg', key: true, width, height, data: Buffer.from(data) });
      };
      ipcMain.on('capture:frame', onFrameMsg);
      const onFailed = (e, message) => {
        if (win && e.sender === win.webContents && !stopped) {
          log(`[capture] ${message}`);
          onExit?.(1);
        }
      };
      ipcMain.on('capture:failed', onFailed);
      const onDisplays = () => !stopped && report();
      screen.on('display-added', onDisplays);
      screen.on('display-removed', onDisplays);
      screen.on('display-metrics-changed', onDisplays);

      // reported after startCapture() has returned: the caller needs its handle first
      setImmediate(() => !stopped && report());
      begin().catch((err) => {
        log(`[capture] ${err.message}`);
        if (!stopped) onExit?.(1);
      });

      return {
        codec: 'jpeg',
        requestKeyframe() {},
        setBitrate() {},
        setMonitor(index) {
          if (!Number.isInteger(index) || index < 0 || index >= displays.length || index === current) return;
          current = index;
          report();
          win?.webContents.executeJavaScript('window.__bifrostCaptureStop()', true).catch(() => {});
          begin().catch((err) => log(`[capture] ${err.message}`));
        },
        stop() {
          stopped = true;
          ipcMain.off('capture:frame', onFrameMsg);
          ipcMain.off('capture:failed', onFailed);
          screen.off('display-added', onDisplays);
          screen.off('display-removed', onDisplays);
          screen.off('display-metrics-changed', onDisplays);
          chosenSource = null;
          if (win && !win.isDestroyed()) win.destroy();
          win = null;
        },
      };
    },
  };
}

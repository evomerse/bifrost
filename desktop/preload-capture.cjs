// Preload of the hidden capture window (macOS / Linux screen capture). It can only hand JPEG
// frames, or a failure message, to the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bifrostCapture', {
  frame: (width, height, bytes) => ipcRenderer.send('capture:frame', width, height, bytes),
  failed: (message) => ipcRenderer.send('capture:failed', String(message).slice(0, 200)),
});

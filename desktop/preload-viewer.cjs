// Preload for remote-viewer windows: hands the page the relay address and, once, what to
// connect to. The password is never put in a URL.
const { contextBridge, ipcRenderer } = require('electron');

const init = ipcRenderer.sendSync('viewer:init');
if (init) {
  contextBridge.exposeInMainWorld('bifrostDesktop', {
    ...init,
    // window.close() is not reliable from a sandboxed page: ask the main process instead.
    close: () => ipcRenderer.send('viewer:close'),
  });
}

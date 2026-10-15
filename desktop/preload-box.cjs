// Preload for the session box (bottom right of the shared PC: who is connected, Stop, and the
// conversation with that person). Sandboxed, and narrower than the control panel's preload: the
// box can only read its own data, send a chat line, resize itself and stop the session.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bifrostBox', {
  init: () => ipcRenderer.invoke('box:init'),
  onMessages: (callback) => ipcRenderer.on('box:messages', (_e, list) => callback(list)),
  onOpen: (callback) => ipcRenderer.on('box:open', (_e, open) => callback(open === true)),
  setOpen: (open) => ipcRenderer.send('box:open', open === true),
  send: (text) => ipcRenderer.invoke('box:send', text),
  stop: () => ipcRenderer.send('box:stop'),
});

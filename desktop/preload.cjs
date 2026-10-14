// Preload for the control panel, the consent dialog and the banner. Sandboxed: it only exposes
// a few named calls; the main process checks the origin of every one of them again.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('bifrost', {
  getState: () => invoke('state:get'),
  onState: (callback) => {
    const listener = (_e, state) => callback(state);
    ipcRenderer.on('state', listener);
    return () => ipcRenderer.removeListener('state', listener);
  },
  setPassword: (password) => invoke('password:set', password),
  clearPassword: () => invoke('password:clear'),
  setServer: (url) => invoke('server:set', url),
  setPermissions: (p) => invoke('perm:set', p),
  addShare: () => invoke('share:add'),
  removeShare: (name) => invoke('share:remove', name),
  setShareWrite: (name, write) => invoke('share:write', { name, write }),
  setSettings: (s) => invoke('settings:set', s),
  setRelay: (enabled, port) => invoke('relay:set', { enabled, port }),
  connect: (target) => invoke('connect', target),
  endSession: () => invoke('session:end'),
  copyId: () => invoke('id:copy'),
  openTransfers: () => invoke('transfers:open'),
  quit: () => invoke('app:quit'),
});

contextBridge.exposeInMainWorld('bifrostConsent', {
  init: () => ipcRenderer.invoke('consent:init'),
  answer: (yes) => ipcRenderer.send('consent:answer', yes === true),
});

contextBridge.exposeInMainWorld('bifrostIndicator', {
  init: () => ipcRenderer.invoke('indicator:init'),
  stop: () => ipcRenderer.send('indicator:stop'),
});

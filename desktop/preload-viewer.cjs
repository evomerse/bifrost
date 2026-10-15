// Preload for remote-viewer windows: hands the page the relay address and, once, what to
// connect to. The password is never put in a URL.
const { contextBridge, ipcRenderer } = require('electron');

const init = ipcRenderer.sendSync('viewer:init');
if (init) {
  contextBridge.exposeInMainWorld('bifrostDesktop', {
    ...init,
    // window.close() is not reliable from a sandboxed page: ask the main process instead.
    close: () => ipcRenderer.send('viewer:close'),
    // Heimdall, the assistant, for the computer this window controls. The conversation and the
    // provider keys stay in the main process; the page only carries the tool calls to the host.
    heimdall: {
      state: () => ipcRenderer.invoke('vheimdall:state'),
      // the host offers the assistant (and runs on this platform), or null when the session is over
      setRemote: (info) => ipcRenderer.invoke('vheimdall:remote', info),
      ask: (text) => ipcRenderer.invoke('vheimdall:ask', text),
      reset: () => ipcRenderer.invoke('vheimdall:reset'),
      // main asks for a tool to be run on the host; the page answers with result()
      onRun: (callback) => {
        ipcRenderer.removeAllListeners('vheimdall:run');
        ipcRenderer.on('vheimdall:run', (_e, req) => callback({ reqId: String(req?.reqId ?? ''), name: String(req?.name ?? ''), args: req?.args ?? {} }));
      },
      result: (reqId, output) => ipcRenderer.send('vheimdall:result', String(reqId), { output: String(output ?? '') }),
    },
  });
}

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  onServerLog: (callback: (log: string) => void) => {
    ipcRenderer.on('server-log', (_event, log: string) => callback(log));
  },
  onServerStatus: (callback: (status: string) => void) => {
    ipcRenderer.on('server-status', (_event, status: string) => callback(status));
  },
});

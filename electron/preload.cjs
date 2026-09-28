const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),
  copyText: text => ipcRenderer.invoke('copy-text', String(text)),
});

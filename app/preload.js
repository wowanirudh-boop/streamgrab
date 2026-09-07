'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sg', {
  getQueue: () => ipcRenderer.invoke('queue:get'),
  addUrl: (url) => ipcRenderer.invoke('download:add', url),
  cancel: (id) => ipcRenderer.invoke('download:cancel', id),
  remove: (id) => ipcRenderer.invoke('download:remove', id),
  retry: (id) => ipcRenderer.invoke('download:retry', id),
  clear: (which) => ipcRenderer.invoke('download:clear', which),
  openFolder: (id) => ipcRenderer.invoke('item:open-folder', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseDir: () => ipcRenderer.invoke('settings:choose-dir'),
  bridgeInfo: () => ipcRenderer.invoke('bridge:info'),
  openLog: () => ipcRenderer.invoke('log:open'),
  onQueueUpdate: (cb) => {
    const listener = (_e, snapshot) => cb(snapshot);
    ipcRenderer.on('queue:update', listener);
    return () => ipcRenderer.removeListener('queue:update', listener);
  }
});

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('validator', {
  info: () => ipcRenderer.invoke('app:info'),
  run: (input) => ipcRenderer.invoke('validate:run', input),
  health: () => ipcRenderer.invoke('diagnostics:health'),
  saveReport: (format) => ipcRenderer.invoke('report:save', format),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  verify: (input) => ipcRenderer.invoke('verify:run', input),
  saveVerifyReport: (format) => ipcRenderer.invoke('verify:save', format)
});

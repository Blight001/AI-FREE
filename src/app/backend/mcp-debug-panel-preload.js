'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const invoke = (action) => () => ipcRenderer.invoke('mcp-debug-panel-request', action);
contextBridge.exposeInMainWorld('aiFree', Object.freeze({
  mcpDebug: Object.freeze({
    catalog: invoke('catalog'),
    openFixture: invoke('openFixture'),
    start: (mode) => ipcRenderer.invoke('mcp-debug-panel-request', 'start', mode),
    stop: invoke('stop'),
    frame: invoke('frame'),
    input: (event) => ipcRenderer.invoke('mcp-debug-panel-request', 'input', event),
    benchmarkStart: invoke('benchmarkStart'),
    restartStatus: invoke('restartStatus'),
    setAutoRestart: (enabled) => ipcRenderer.invoke('mcp-debug-panel-request', 'setAutoRestart', { enabled }),
    restartApp: invoke('restartApp'),
  }),
}));

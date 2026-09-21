'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { bindMainWindowEvents } = require('../../../src/app/backend/services/app-shell-main-window');

function createWindow() {
  const window = new EventEmitter();
  window.webContents = new EventEmitter();
  window.webContents.send = () => {};
  window.isDestroyed = () => false;
  window.isMinimized = () => false;
  window.isMaximized = () => true;
  window.getContentSize = () => [1200, 800];
  window.getNormalBounds = () => ({ width: 1200, height: 800 });
  return window;
}

test('恢复主窗口时分阶段重新显示运行中的内嵌浏览器', async () => {
  const mainWindow = createWindow();
  const shown = [];
  const resized = [];
  const deps = {
    browserRuntimeManager: {
      listStates: () => [
        { profileId: 'active', runtimeType: 'chromium', status: 'ready' },
        { profileId: 'hidden', runtimeType: 'chromium', status: 'hidden' },
      ],
      show: async (profileId) => { shown.push(profileId); },
      resize: async (...args) => { resized.push(args); },
    },
    getIsSidebarVisible: () => true,
    resolveActiveTabId: () => null,
    resolveTabs: () => new Map(),
    getSideView: () => null,
    updateTabs: () => {},
    logger: { warn() {} },
  };

  bindMainWindowEvents(deps, mainWindow);
  mainWindow.emit('restore');
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.ok(shown.length >= 3);
  assert.ok(shown.every((profileId) => profileId === 'active'));
  assert.deepEqual(resized, []);
});

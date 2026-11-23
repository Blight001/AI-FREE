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

test('主窗口最小化时保留内嵌浏览器布局，恢复后同步当前尺寸', async () => {
  const mainWindow = createWindow();
  const resized = [];
  const [width, height] = mainWindow.getContentSize();
  const tab = { id: 'active', runtimeType: 'chromium' };
  const deps = {
    browserRuntimeManager: { resize: async (...args) => { resized.push(args); } },
    getIsSidebarVisible: () => false,
    resolveActiveTabId: () => tab.id,
    resolveTabs: () => new Map([[tab.id, tab]]),
    updateTabs: () => {},
    setMainWindow: () => {},
  };
  bindMainWindowEvents(deps, mainWindow);
  try {
    mainWindow.emit('resize');
    assert.equal(resized.length, 1);
    const foregroundBounds = resized[0][2];

    mainWindow.isMinimized = () => true;
    mainWindow.getContentSize = () => [0, 0];
    mainWindow.emit('resize');
    assert.equal(resized.length, 1, '最小化不能把零尺寸传给浏览器');

    mainWindow.isMinimized = () => false;
    mainWindow.getContentSize = () => [width + 100, height + 50];
    mainWindow.emit('restore');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(resized[1], [tab.id, 'chromium', {
      ...foregroundBounds,
      width: foregroundBounds.width + 100,
      height: foregroundBounds.height + 50,
    }]);
  } finally {
    mainWindow.emit('closed');
  }
});

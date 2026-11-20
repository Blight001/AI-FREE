'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createAppState } = require('../../../src/app/backend/runtime/app-state');
const { createAppShellMainWindowController } = require('../../../src/app/backend/services/app-shell-main-window');
const { createAppShellWindowStateController } = require('../../../src/app/backend/services/app-shell-window-state');

function createMainWindowFixture(storedState) {
  const views = [];
  let mainWindow = null;
  let sideView = null;
  let maximizeCalls = 0;
  const loadedPages = [];
  const shellMessages = [];
  class FakeView {
    constructor() {
      this.visible = true;
      this.bounds = null;
      this.webContents = {
        session: {},
        loadFile: async (file) => { loadedPages.push(file); },
        on: () => {},
      };
      views.push(this);
    }
    getBounds() { return this.bounds || { width: 300 }; }
    setBounds(bounds) { this.bounds = bounds; }
    setVisible(visible) { this.visible = visible; }
  }
  class FakeWindow {
    constructor() {
      this.events = new Map();
      this.webContents = Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        send: (channel, payload) => shellMessages.push({ channel, payload }),
      });
      this.contentView = { addChildView: () => {} };
    }
    on(name, listener) {
      const listeners = this.events.get(name) || [];
      listeners.push(listener);
      this.events.set(name, listeners);
    }
    once(name, listener) { this.on(name, listener); }
    emit(name) { for (const listener of this.events.get(name) || []) listener(); }
    getContentSize() { return [1000, 700]; }
    getNormalBounds() { return { width: 1000, height: 700 }; }
    getBounds() { return this.getNormalBounds(); }
    isDestroyed() { return false; }
    isMaximized() { return true; }
    isMinimized() { return false; }
    loadFile() {}
    maximize() { maximizeCalls += 1; }
    setAutoHideMenuBar() {}
    setMenu() {}
    setMenuBarVisibility() {}
    setTitle() {}
  }
  class FakeTray {
    isDestroyed() { return false; }
    on() {}
    setContextMenu() {}
    setToolTip() {}
  }
  const windowDeps = {
    app: { getPath: () => 'C:/tmp', on: () => {}, once: () => {} },
    fs: {
      existsSync: (file) => Boolean(storedState) && file.endsWith('.json'),
      readFileSync: () => JSON.stringify(storedState),
    },
    path, screen: {}, logger: { error: () => {}, log: () => {}, warn: () => {} },
  };
  const windowStateController = createAppShellWindowStateController(windowDeps);
  const runtime = createAppState(windowStateController);
  const controller = createAppShellMainWindowController({
    ...windowDeps,
    windowStateController,
    APP_DISPLAY_NAME: 'AI-FREE', BrowserWindow: FakeWindow, WebContentsView: FakeView, Tray: FakeTray,
    Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
    resolveAppIconPath: () => 'C:/app/logo.ico',
    attachContextMenu: () => {}, resolveAddTab: () => null, resolveTabs: () => new Map(),
    resolveActiveTabId: () => null, resolveRefreshActiveTab: () => null, resolveAuth: () => null,
    resolveControlPanelHtmlPath: (fileName) => `C:/app/frontend/sidebar/${fileName}`,
    getSideView: () => sideView, setSideView: (view) => { sideView = view; },
    setMainWindow: (window) => { mainWindow = window; }, resolveMainWindow: () => mainWindow,
    resolveControlPanelWindow: () => null,
    getIsSidebarVisible: runtime.getIsSidebarVisible, isControlPanelModeEnabled: () => false,
  });
  return { controller, views, loadedPages, shellMessages, getMaximizeCalls: () => maximizeCalls };
}

test('浏览器配置内嵌主窗口且只创建侧边栏子视图', () => {
  const { controller, views, loadedPages, shellMessages, getMaximizeCalls } = createMainWindowFixture();
  const window = controller.createMainWindow();
  assert.equal(getMaximizeCalls(), 1);
  window.emit('ready-to-show');
  assert.equal(views.length, 1);
  assert.deepEqual(loadedPages, ['C:/app/frontend/sidebar/ai-control.html']);
  assert.deepEqual(views[0].bounds, { x: 700, y: 0, width: 300, height: 659 });
  assert.equal(views[0].visible, true);
  assert.equal(controller.setSidebarWidth(500), 500);
  assert.deepEqual(views[0].bounds, { x: 500, y: 0, width: 500, height: 659 });
  assert.deepEqual(shellMessages.at(-1), {
    channel: 'sidebar-width-changed', payload: { visible: true, width: 500 },
  });
  assert.equal(controller.setSidebarWidth(900), 680);
  assert.deepEqual(views[0].bounds, { x: 320, y: 0, width: 680, height: 659 });
  assert.deepEqual(shellMessages.at(-1), {
    channel: 'sidebar-width-changed', payload: { visible: true, width: 680 },
  });
  window.emit('closed');
});

test('上次收起 AI 侧边栏时，本次窗口首次加载不预留侧边栏宽度', () => {
  const { controller, views, loadedPages, shellMessages } = createMainWindowFixture({
    version: 1,
    bounds: { width: 1000, height: 700 },
    sidebarWidth: 500,
    sidebarVisible: false,
  });
  const window = controller.createMainWindow();
  assert.equal(views.length, 1);
  assert.equal(views[0].visible, false);
  assert.deepEqual(loadedPages, ['C:/app/frontend/sidebar/ai-control.html']);
  window.emit('ready-to-show');
  assert.deepEqual(shellMessages.at(-1), {
    channel: 'sidebar-width-changed', payload: { visible: false, width: 0 },
  });
  assert.equal(controller.setSidebarWidth(550), 0);
  window.emit('closed');
});

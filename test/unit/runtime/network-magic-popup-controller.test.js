'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const electronPath = require.resolve('electron');
const controllerPath = require.resolve('../../../src/app/backend/features/network/network-magic-popup-controller');

function loadController(browserWindowFactory) {
  const created = [];
  const originalElectron = require.cache[electronPath];
  const originalController = require.cache[controllerPath];
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      BrowserWindow: function MockBrowserWindow(options) {
        const win = browserWindowFactory(options, created);
        created.push(win);
        return win;
      },
      screen: {
        getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      },
    },
    children: [],
    paths: [],
  };
  delete require.cache[controllerPath];
  try {
    return { created, controller: require(controllerPath) };
  } finally {
    if (originalElectron) require.cache[electronPath] = originalElectron;
    else delete require.cache[electronPath];
    if (originalController) require.cache[controllerPath] = originalController;
    else delete require.cache[controllerPath];
  }
}

function createMockWindow(options) {
  const listeners = {};
  return {
    options,
    destroyed: false,
    bounds: { x: options.x, y: options.y, width: options.width, height: options.height },
    isDestroyed: () => false,
    setAlwaysOnTop() {},
    setBounds(bounds) { this.bounds = bounds; },
    show() { this.shown = true; },
    focus() { this.focused = true; },
    close() { listeners.closed?.forEach((handler) => handler()); },
    loadFile(file) { this.loadedFile = file; },
    once(event, handler) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(handler);
    },
    on(event, handler) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(handler);
    },
    emit(event) {
      (listeners[event] || []).forEach((handler) => handler());
    },
  };
}

test('内置代理弹窗作为独立置顶窗口打开，不切换 AI 控制', () => {
  const { created, controller } = loadController((options) => createMockWindow(options));
  const events = [];
  const popup = controller.createNetworkMagicPopupController({
    ui: {
      getMainWindow: () => ({
        isDestroyed: () => false,
        getContentBounds: () => ({ x: 100, y: 80, width: 1200, height: 800 }),
      }),
      getSideView: () => ({
        getVisible: () => true,
        getBounds: () => ({ width: 360 }),
      }),
      sendToSide: (...args) => events.push(args),
      openAiControlSidebar: () => events.push(['open-ai-control']),
    },
  });

  assert.equal(popup.toggle({
    open: true,
    anchor: { left: 720, right: 800, top: 760, bottom: 792 },
  }), true);
  assert.equal(created.length, 1);
  assert.equal(created[0].options.alwaysOnTop, true);
  assert.equal(created[0].options.frame, false);
  assert.equal(created[0].options.x, 100 + 760 - 224);
  assert.equal(created[0].options.y, 80 + 760 - 248 - 8);
  assert.match(created[0].loadedFile.replace(/\\/g, '/'), /frontend\/views\/network-magic-popup.html$/);
  created[0].emit('ready-to-show');
  assert.equal(created[0].shown, true);
  assert.deepEqual(events, [['network-magic-panel-toggle', { open: true }]]);

  popup.toggle({ open: false });
  assert.deepEqual(events.at(-1), ['network-magic-panel-toggle', { open: false }]);
  assert.equal(events.some((item) => item[0] === 'open-ai-control'), false);
});

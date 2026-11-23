'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const electronPath = require.resolve('electron');
const controllerPath = require.resolve('../../../src/app/backend/features/network/network-magic-popup-controller');

function loadController(browserWindowFactory, getCursorScreenPoint = () => ({ x: 0, y: 0 })) {
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
        getCursorScreenPoint,
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
    getBounds() { return this.bounds; },
    getParentWindow() { return options.parent; },
    isVisible() { return this.shown === true; },
    isFocused() { return this.focused === true; },
    hide() { this.shown = false; },
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
      if (event === 'blur') this.focused = false;
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
    anchor: { left: 720, right: 800, top: 760, bottom: 792 },
  }), true);
  assert.equal(created.length, 1);
  assert.equal(created[0].options.alwaysOnTop, true);
  assert.equal(created[0].options.frame, false);
  assert.equal(created[0].options.x, 100 + 760 - 106);
  assert.equal(created[0].options.y + created[0].options.height, 80 + 760 - 8);
  assert.match(created[0].loadedFile.replace(/\\/g, '/'), /frontend\/views\/network-magic-popup.html$/);
  created[0].emit('ready-to-show');
  assert.equal(created[0].shown, true);
  assert.deepEqual(events, [['network-magic-panel-toggle', { open: true }]]);

  popup.toggle();
  assert.deepEqual(events.at(-1), ['network-magic-panel-toggle', { open: false }]);
  assert.equal(events.some((item) => item[0] === 'open-ai-control'), false);
});

test('内置代理弹窗失焦后隐藏，节点列表伸缩不抢回焦点', async () => {
  const { created, controller } = loadController(createMockWindow);
  const events = [];
  const popup = controller.createNetworkMagicPopupController({
    ui: {
      getMainWindow: () => ({ getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }) }),
      sendToSide: (_channel, payload) => events.push(payload.open),
    },
  });
  popup.toggle();
  created[0].emit('ready-to-show');
  created[0].emit('blur');
  await new Promise(setImmediate);
  assert.equal(created[0].isVisible(), false);
  assert.deepEqual(events, [true, false]);

  popup.resize({ size: 'expanded' });
  assert.equal(created[0].isVisible(), false);
  assert.equal(created[0].getBounds().height, 340);
  popup.toggle();
  assert.equal(created.length, 1);
  assert.equal(created[0].isVisible(), true);
  assert.equal(created[0].getBounds().height, 340);
  assert.deepEqual(events, [true, false, true]);
  popup.resize({ size: 'compact' });
  assert.equal(created[0].getBounds().width, 212);
  assert.equal(created[0].getBounds().height, 80);
  popup.close();
});

test('点击底栏造成的失焦由同一次点击收回，且重新打开会复用弹窗', async () => {
  const anchor = { left: 500, right: 580, top: 540, bottom: 570 };
  const parent = {
    getContentBounds: () => ({ x: 100, y: 80, width: 1200, height: 900 }),
    webContents: { getZoomFactor: () => 1.5 },
    isFocused: () => parentFocused,
  };
  let parentFocused = false;
  let pointer = { x: 910, y: 912 };
  const { created, controller } = loadController(createMockWindow, () => pointer);
  const events = [];
  const popup = controller.createNetworkMagicPopupController({
    ui: { getMainWindow: () => parent, sendToSide: (_channel, payload) => events.push(payload.open) },
  });

  popup.toggle({ anchor });
  const win = created[0];
  assert.ok(win, '底栏发送切换意图后打开弹窗');
  win.emit('ready-to-show');
  win.emit('blur');
  parentFocused = true;
  await new Promise(setImmediate);
  popup.toggle({ anchor });
  assert.equal(win.isVisible(), false);
  assert.deepEqual(events, [true, false]);

  popup.toggle({ anchor });
  assert.equal(popup.getWindow(), win);
  assert.equal(win.isVisible(), true);
  // 点主窗口中不是底栏代理按钮的位置仍会收回。
  pointer = { x: 100, y: 100 };
  win.emit('blur');
  await new Promise(setImmediate);
  assert.equal(win.isVisible(), false);
  assert.deepEqual(events, [true, false, true, false]);

  // 光标在底栏位置，但焦点转移到了其他窗口，也应收回。
  popup.toggle({ anchor });
  pointer = { x: 910, y: 912 };
  parentFocused = false;
  win.emit('blur');
  await new Promise(setImmediate);
  assert.equal(win.isVisible(), false);
  assert.deepEqual(events, [true, false, true, false, true, false]);
  popup.close();
});

test('弹窗加载时再次切换会取消显示，加载结束后仍可重新打开', () => {
  const { created, controller } = loadController(createMockWindow);
  const popup = controller.createNetworkMagicPopupController({
    ui: { getMainWindow: () => ({ getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }) }) },
  });
  popup.toggle({});
  const win = created[0];
  assert.ok(win);
  popup.toggle({});
  win.emit('ready-to-show');
  assert.equal(win.isVisible(), false);
  popup.toggle({});
  assert.equal(popup.getWindow(), win);
  assert.equal(win.isVisible(), true);
  popup.close();
});

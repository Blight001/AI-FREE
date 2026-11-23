'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const electronPath = require.resolve('electron');
const targetPath = require.resolve('../../../src/app/backend/features/browser/tab-context-menu-controller');
const originalElectron = require.cache[electronPath];
const createdWindows = [];

class FakeBrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    createdWindows.push(this);
  }
  isDestroyed() { return this.destroyed; }
  loadURL(url) { this.url = url; }
  show() {}
  close() { this.destroyed = true; this.emit('closed'); }
}

require.cache[electronPath] = { exports: {
  BrowserWindow: FakeBrowserWindow,
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
} };
delete require.cache[targetPath];
const { buildTabContextMenuHtml, createTabContextMenuController } = require(targetPath);
if (originalElectron) require.cache[electronPath] = originalElectron;
else delete require.cache[electronPath];
delete require.cache[targetPath];

test('browser context menu offers restart, close, and history rename only', () => {
  const html = buildTabContextMenuHtml('profile-1', 'history-1');

  assert.match(html, />重启浏览器</);
  assert.match(html, />关闭浏览器</);
  assert.match(html, />重命名浏览器</);
  assert.doesNotMatch(html, /清空浏览器数据/);
  assert.match(html, /closeTab\(tabId\)/);
  assert.match(html, /renameHistory\(\{historyId,name\}\)/);
  assert.ok(html.includes('history-1'));
});

test('transparent context menu window does not paint a square native background', () => {
  createdWindows.length = 0;
  const controller = createTabContextMenuController();
  const opened = controller.openTabContextMenuWindow({
    tabId: 'profile-1',
    parentWindow: { isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 500, height: 500 }) },
  });

  assert.equal(opened, true);
  assert.equal(createdWindows.length, 1);
  assert.equal(createdWindows[0].options.transparent, true);
  assert.equal(createdWindows[0].options.backgroundColor, '#00000000');
  controller.closeTabContextMenuWindow();
});

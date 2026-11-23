'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { findBrowserHistoryGestureRowAtPoint } = require('../../../src/app/shared/browser-history-gesture-layout');

const electronPath = require.resolve('electron');
const targetPath = require.resolve('../../../src/app/backend/features/browser/browser-history-popup-controller');
const originalElectron = require.cache[electronPath];
const popupWindows = [];

class FakeBrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.webContents = { isDestroyed: () => false, send() {} };
    popupWindows.push(this);
  }
  isDestroyed() { return this.destroyed; }
  setIgnoreMouseEvents() {}
  loadURL(url) { this.loadedUrl = url; }
  showInactive() {}
  close() { this.destroyed = true; this.emit('closed'); }
}

require.cache[electronPath] = {
  exports: {
    BrowserWindow: FakeBrowserWindow,
    screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  },
};
delete require.cache[targetPath];
const { createBrowserHistoryPopupController } = require(targetPath);
if (originalElectron) require.cache[electronPath] = originalElectron;
else delete require.cache[electronPath];
delete require.cache[targetPath];

test('popup hit coordinates share the rounded BrowserWindow origin and rendered row geometry', () => {
  popupWindows.length = 0;
  const contentBounds = { x: 100.25, y: 80.5, width: 900, height: 700 };
  const controller = createBrowserHistoryPopupController({
    ui: { getMainWindow: () => ({ isDestroyed: () => false, getContentBounds: () => contentBounds }) },
  });
  const response = controller.show({
    anchor: { left: 320.3, right: 350.3, top: 500.25 },
    history: [{ id: 'first' }, { id: 'second' }, { id: 'third' }],
  });
  const popup = popupWindows[0];
  const { layout } = response;

  assert.equal(response.ok, true);
  assert.equal(layout.x, popup.options.x - contentBounds.x);
  assert.equal(layout.y, popup.options.y - contentBounds.y);
  assert.equal(layout.width, popup.options.width);
  assert.equal(layout.height, popup.options.height);
  const html = decodeURIComponent(popup.loadedUrl.slice('data:text/html;charset=utf-8,'.length));
  assert.match(html, /height: 72px/);
  assert.match(html, /margin-top: 3px/);

  for (const row of layout.rows) {
    const pointerY = layout.y + (row.top + row.bottom) / 2;
    assert.equal(findBrowserHistoryGestureRowAtPoint(layout, layout.x + 40, pointerY)?.id, row.id);
  }
});

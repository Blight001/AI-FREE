'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { RemoteBrowserPeerController } = require('../../../src/app/backend/features/browser/remote-browser-peer-controller');

class FakeBrowserWindow {
  static latest = null;

  constructor(options) {
    this.options = options;
    this.destroyed = false;
    this.scripts = [];
    this.handlers = new Map();
    this.webContents = {
      executeJavaScript: async (script) => {
        this.scripts.push(script);
        if (script.includes('.drain()')) return [{ event: 'offer', sessionId: 'rc-1', sdp: 'offer' }];
        return undefined;
      },
    };
    FakeBrowserWindow.latest = this;
  }

  async loadFile(filePath) {
    this.filePath = filePath;
  }

  once(event, handler) {
    this.handlers.set(event, handler);
  }

  isDestroyed() {
    return this.destroyed;
  }

  destroy() {
    this.destroyed = true;
    this.handlers.get('closed')?.();
  }
}

test('远程浏览器 peer 使用隔离隐藏 renderer 并只回传结构化 WebRTC 消息', async (t) => {
  const messages = [];
  const controller = new RemoteBrowserPeerController({
    BrowserWindow: FakeBrowserWindow,
    onMessage: (message) => messages.push(message),
  });
  t.after(() => controller.stop());
  await controller.start('rc-1', [{ urls: 'stun:test' }]);
  const win = FakeBrowserWindow.latest;
  assert.equal(win.options.show, false);
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.equal(fs.statSync(win.filePath).isFile(), true);
  assert.equal(fs.statSync(path.join(path.dirname(win.filePath), 'remote-browser-peer.js')).isFile(), true);
  assert.match(win.scripts[0], /remoteBrowserPeer\.start/);

  await controller.poll();
  assert.deepEqual(messages, [{ event: 'offer', sessionId: 'rc-1', sdp: 'offer' }]);
  await controller.stop();
  assert.equal(win.destroyed, true);
});

test('远程 peer 保留显式页面覆盖并可在关闭后重新创建', async (t) => {
  const viewPath = path.resolve('fixture/peer.html');
  const controller = new RemoteBrowserPeerController({ BrowserWindow: FakeBrowserWindow, viewPath });
  t.after(() => controller.stop());
  await controller.start('rc-1', []);
  const first = FakeBrowserWindow.latest;
  assert.equal(first.filePath, viewPath);
  await controller.stop();
  await controller.start('rc-2', []);
  assert.notEqual(FakeBrowserWindow.latest, first);
  assert.equal(FakeBrowserWindow.latest.filePath, viewPath);
  assert.equal(first.destroyed, true);
});

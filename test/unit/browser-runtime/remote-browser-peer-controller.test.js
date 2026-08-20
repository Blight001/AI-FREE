'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { RemoteBrowserPeerController } = require('../../../src/app/main/features/browser/remote-browser-peer-controller');

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

test('远程浏览器 peer 使用隔离隐藏 renderer 并只回传结构化 WebRTC 消息', async () => {
  const messages = [];
  const controller = new RemoteBrowserPeerController({
    BrowserWindow: FakeBrowserWindow,
    onMessage: (message) => messages.push(message),
  });
  await controller.start('rc-1', [{ urls: 'stun:test' }]);
  const win = FakeBrowserWindow.latest;
  assert.equal(win.options.show, false);
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.match(win.filePath, /remote-browser-peer\.html$/);
  assert.match(win.scripts[0], /remoteBrowserPeer\.start/);

  await controller.poll();
  assert.deepEqual(messages, [{ event: 'offer', sessionId: 'rc-1', sdp: 'offer' }]);
  await controller.stop();
  assert.equal(win.destroyed, true);
});

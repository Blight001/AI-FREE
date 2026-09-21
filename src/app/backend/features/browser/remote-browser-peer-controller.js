'use strict';

const path = require('path');

const POLL_INTERVAL_MS = 50;

function serialize(value) {
  return JSON.stringify(value === undefined ? null : value);
}

class RemoteBrowserPeerController {
  constructor(options = {}) {
    this.BrowserWindow = options.BrowserWindow;
    this.logger = options.logger || console;
    this.viewPath = options.viewPath || path.join(__dirname, '../../views/remote-browser-peer.html');
    this.onMessage = options.onMessage || (() => {});
    this.window = null;
    this.ready = null;
    this.pollTimer = null;
    this.polling = false;
  }

  async ensureReady() {
    if (this.window && !this.window.isDestroyed?.()) return this.ready;
    const BrowserWindow = this.BrowserWindow;
    if (typeof BrowserWindow !== 'function') throw new Error('远程浏览器 WebRTC 宿主不可用');
    const win = new BrowserWindow({
      show: false,
      width: 320,
      height: 180,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.window = win;
    this.ready = win.loadFile(this.viewPath);
    win.once?.('closed', () => {
      if (this.window === win) this.window = null;
      this.stopPolling();
    });
    await this.ready;
    this.startPolling();
  }

  async call(method, payload = {}) {
    await this.ensureReady();
    const target = this.window;
    if (!target || target.isDestroyed?.()) throw new Error('远程浏览器 WebRTC 宿主已关闭');
    const script = `window.remoteBrowserPeer.${method}(${serialize(payload)})`;
    return target.webContents.executeJavaScript(script, true);
  }

  start(sessionId, iceServers) {
    return this.call('start', { sessionId, iceServers });
  }

  answer(sessionId, sdp) {
    return this.call('answer', { sessionId, sdp });
  }

  ice(sessionId, candidate) {
    return this.call('ice', { sessionId, candidate });
  }

  frame(sessionId, dataUrl) {
    return this.call('frame', { sessionId, dataUrl });
  }

  browserState(sessionId, state) {
    return this.call('browserState', { sessionId, state });
  }

  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async poll() {
    if (this.polling || !this.window || this.window.isDestroyed?.()) return;
    this.polling = true;
    try {
      const messages = await this.window.webContents.executeJavaScript('window.remoteBrowserPeer.drain()', true);
      for (const message of Array.isArray(messages) ? messages : []) this.onMessage(message);
    } catch (error) {
      if (this.window && !this.window.isDestroyed?.()) {
        this.logger.warn?.('[RemoteBrowser] 读取 WebRTC 消息失败:', error?.message || error);
      }
    } finally {
      this.polling = false;
    }
  }

  async stop() {
    this.stopPolling();
    const win = this.window;
    this.window = null;
    this.ready = null;
    if (!win || win.isDestroyed?.()) return;
    try { await win.webContents.executeJavaScript('window.remoteBrowserPeer.cleanup()', true); } catch (_) {}
    try { win.destroy(); } catch (_) {}
  }
}

function createRemoteBrowserPeerController(options) {
  return new RemoteBrowserPeerController(options);
}

module.exports = { RemoteBrowserPeerController, createRemoteBrowserPeerController };

'use strict';

const path = require('node:path');

function createDevConsoleWindowController(deps) {
  let pending = null;
  const failure = (code, message) => ({ ok: false, error: { code, message, retryable: false } });

  async function open() {
    if (!deps.isDevMode) return failure('DEV_MODE_REQUIRED', '调试控制台仅在开发模式可用');
    if (pending) return pending;
    const existing = deps.getDevConsoleWindow?.();
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return { ok: true, data: { opened: true } };
    }
    pending = load();
    try { return await pending; } finally { pending = null; }
  }

  async function load() {
    const window = new deps.BrowserWindow({
      parent: deps.getMainWindow?.() || undefined,
      width: 1100, height: 760, minWidth: 640, minHeight: 420,
      title: '调试控制台', show: false, autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false, contextIsolation: true,
        preload: path.join(__dirname, '../../preload.js'),
      },
    });
    if (typeof deps.setDevConsoleWindow !== 'function') {
      window.destroy();
      return failure('DEV_CONSOLE_UNAVAILABLE', '调试控制台窗口未完成装配');
    }
    deps.setDevConsoleWindow(window);
    window.setMenu(null);
    window.once('closed', () => {
      if (deps.getDevConsoleWindow() === window) deps.setDevConsoleWindow(null);
    });
    try {
      await window.loadFile(path.join(__dirname, '../../frontend/views/dev-console.html'));
      if (window.isDestroyed()) return failure('WINDOW_CLOSED', '调试窗口已关闭');
      window.show();
      window.focus();
      return { ok: true, data: { opened: true } };
    } catch (error) {
      if (!window.isDestroyed()) window.destroy();
      deps.logger?.warn?.('[调试控制台] 页面加载失败:', error?.message);
      return failure('DEV_CONSOLE_LOAD_FAILED', '调试控制台加载失败');
    }
  }

  return { open };
}

module.exports = { createDevConsoleWindowController };

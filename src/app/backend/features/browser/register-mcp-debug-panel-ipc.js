'use strict';

const { pathToFileURL } = require('node:url');
const { isHomeSender } = require('../window/home-dev-sender');
const { resolveMcpDebugWindowPaths } = require('../../config/paths');
const { openMcpDebugFixture } = require('./mcp-debug-fixture');
const { createMcpMouseDebugSession } = require('./mcp-mouse-debug-session');
const { readMcpCatalog } = require('./register-mcp-catalog-ipc');

function failure(code, message) { return { ok: false, error: { code, message } }; }
function success(data) { return { ok: true, data }; }

function isPanelSender(event, panel, viewUrl) {
  const contents = panel?.webContents;
  return Boolean(contents && !contents.isDestroyed() && event.sender === contents
    && event.senderFrame === contents.mainFrame && event.senderFrame?.url === viewUrl);
}

function registerMcpDebugPanelIpc(ipc, deps) {
  const { isDevMode, getMainWindow, BrowserWindow, browserAutomationBridge: bridge, browserRuntimeManager: runtime } = deps;
  const { view, preload } = resolveMcpDebugWindowPaths();
  const viewUrl = pathToFileURL(view).href;
  let entry = null;
  let opening = null;
  const close = () => entry?.panel.close();
  const handles = [ipc.handle('open-mcp-debug-panel', (event) => {
    const owner = getMainWindow();
    if (!isDevMode || !isHomeSender(event, owner?.webContents)) return failure('DEV_MODE_REQUIRED', '仅开发模式首页可打开调试面板');
    if (opening) return opening;
    if (entry) {
      entry.panel.show();
      return success({ opened: true });
    }
    opening = open(owner).catch((error) => failure('MCP_DEBUG_OPEN_FAILED', error.message))
      .finally(() => { opening = null; });
    return opening;
  }), ipc.handle('mcp-debug-panel-request', async (event, action, input) => {
    if (!isDevMode || !isPanelSender(event, entry?.panel, viewUrl)) return failure('MCP_DEBUG_PANEL_REQUIRED', '仅调试面板可调用');
    try {
      if (action === 'catalog') return success(readMcpCatalog(deps));
      if (!['openFixture', 'start', 'stop', 'frame', 'input'].includes(action)) return failure('MCP_DEBUG_ACTION_INVALID', '未知调试操作');
      if (['start', 'input'].includes(action) && !entry.panel.isFocused()) return failure('MCP_DEBUG_PANEL_NOT_FOCUSED', '请先聚焦调试面板');
      return success(await entry.session[action](input));
    } catch (error) {
      return failure(error.code || 'MCP_DEBUG_FAILED', error.message || 'MCP 调试失败');
    }
  })];

  async function open(owner) {
    if (owner.isDestroyed()) return failure('MCP_DEBUG_WINDOW_CLOSED', '主窗口已关闭');
    const panel = new BrowserWindow({
      width: 1000, height: 720, minWidth: 620, minHeight: 450, show: false, autoHideMenuBar: true,
      title: 'MCP 调试面板', backgroundColor: '#f3f5f8',
      webPreferences: { preload, sandbox: true, nodeIntegration: false, contextIsolation: true },
    });
    let fixture;
    let session;
    const stop = () => session?.stop().catch((error) => deps.logger?.warn?.('[MCP Debug]', error.code || 'MCP_DEBUG_RELEASE_FAILED'));
    panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    panel.webContents.on('will-navigate', (event) => event.preventDefault());
    panel.webContents.on('render-process-gone', () => panel.close());
    panel.on('blur', stop);
    owner.once('close', close);
    const cleanup = () => {
      if (entry?.panel === panel) entry = null;
      owner.off('close', close);
      fixture?.close();
      void stop();
    };
    panel.on('closed', cleanup);
    entry = { panel, session: null };
    try {
      fixture = await openMcpDebugFixture();
      if (panel.isDestroyed()) { fixture.close(); return failure('MCP_DEBUG_WINDOW_CLOSED', '调试面板已关闭'); }
      session = createMcpMouseDebugSession({ fixtureUrl: fixture.url, bridge, runtime });
      entry.session = session;
      await panel.loadFile(view);
      if (!panel.isDestroyed()) panel.show();
      return success({ opened: true });
    } catch (error) {
      if (!panel.isDestroyed()) panel.destroy();
      throw error;
    }
  }

  return () => { close(); for (const dispose of handles) dispose?.(); };
}

module.exports = { registerMcpDebugPanelIpc };

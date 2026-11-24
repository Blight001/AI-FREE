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

async function dispatchRestartAction(action, input, entry, deps) {
  if (action === 'restartStatus') return success(deps.mcpDevRestart?.getStatus() || { available: false });
  if (action === 'setAutoRestart') {
    if (!entry.panel.isFocused()) return failure('MCP_DEBUG_PANEL_NOT_FOCUSED', '请先聚焦调试面板');
    if (typeof input?.enabled !== 'boolean') return failure('MCP_DEBUG_INPUT_INVALID', '重启开关必须为布尔值');
    return success(deps.mcpDevRestart?.setAutoRestart(input.enabled) || { available: false });
  }
  if (action !== 'restartApp') return null;
  if (!entry.panel.isFocused()) return failure('MCP_DEBUG_PANEL_NOT_FOCUSED', '请先聚焦调试面板');
  if (!deps.mcpDevRestart) return failure('MCP_DEV_RESTART_UNAVAILABLE', '应用重启仅在源码开发模式可用');
  return success(await deps.mcpDevRestart.restart());
}

async function dispatchPanelAction(action, input, entry, deps) {
  if (action === 'catalog') return success(readMcpCatalog(deps));
  const restartResult = await dispatchRestartAction(action, input, entry, deps);
  if (restartResult) return restartResult;
  if (action === 'benchmarkStart') {
    if (!entry.panel.isFocused()) return failure('MCP_DEBUG_PANEL_NOT_FOCUSED', '请先聚焦调试面板');
    if (!deps.benchmark) return failure('MCP_BENCHMARK_UNAVAILABLE', '基准测试服务尚未就绪');
    return success(await deps.benchmark.start());
  }
  if (!['openFixture', 'start', 'stop', 'frame', 'input'].includes(action)) {
    return failure('MCP_DEBUG_ACTION_INVALID', '未知调试操作');
  }
  if (['start', 'input'].includes(action) && !entry.panel.isFocused()) {
    return failure('MCP_DEBUG_PANEL_NOT_FOCUSED', '请先聚焦调试面板');
  }
  return success(await entry.session[action](input));
}

function registerPanelRequest(ipc, deps, state, viewUrl) {
  return ipc.handle('mcp-debug-panel-request', async (event, action, input) => {
    const entry = state.entry;
    if (!deps.isDevMode || !isPanelSender(event, entry?.panel, viewUrl)) {
      return failure('MCP_DEBUG_PANEL_REQUIRED', '仅调试面板可调用');
    }
    try { return await dispatchPanelAction(action, input, entry, deps); }
    catch (error) {
      return failure(error.code || 'MCP_DEBUG_FAILED', error.message || 'MCP 调试失败');
    }
  });
}

async function openPanel(owner, deps, state, view, preload) {
  if (owner.isDestroyed()) return failure('MCP_DEBUG_WINDOW_CLOSED', '主窗口已关闭');
  const panel = new deps.BrowserWindow({ width: 1000, height: 720, minWidth: 620, minHeight: 450,
    show: false, autoHideMenuBar: true, title: 'MCP 调试面板', backgroundColor: '#f3f5f8',
    webPreferences: { preload, sandbox: true, nodeIntegration: false, contextIsolation: true } });
  let fixture;
  let session;
  const stop = () => session?.stop().catch((error) => deps.logger?.warn?.('[MCP Debug]', error.code || 'MCP_DEBUG_RELEASE_FAILED'));
  panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  panel.webContents.on('will-navigate', (event) => event.preventDefault());
  panel.webContents.on('render-process-gone', () => panel.close());
  panel.on('blur', stop);
  const closeOwner = () => panel.close();
  owner.once('close', closeOwner);
  const cleanup = () => {
    deps.mcpDevRestart?.setAutoRestart(false);
    if (state.entry?.panel === panel) state.entry = null;
    owner.off('close', closeOwner);
    fixture?.close();
    void stop();
  };
  panel.on('closed', cleanup);
  state.entry = { panel, session: null };
  try {
    fixture = await openMcpDebugFixture();
    if (panel.isDestroyed()) { fixture.close(); return failure('MCP_DEBUG_WINDOW_CLOSED', '调试面板已关闭'); }
    session = createMcpMouseDebugSession({ fixtureUrl: fixture.url,
      bridge: deps.browserAutomationBridge, runtime: deps.browserRuntimeManager });
    state.entry.session = session;
    await panel.loadFile(view);
    if (!panel.isDestroyed()) panel.show();
    return success({ opened: true });
  } catch (error) {
    if (!panel.isDestroyed()) panel.destroy();
    throw error;
  }
}

function registerMcpDebugPanelIpc(ipc, deps) {
  const { view, preload } = resolveMcpDebugWindowPaths();
  const viewUrl = pathToFileURL(view).href;
  const state = { entry: null, opening: null };
  const removeDebugBusyCheck = deps.mcpDevRestart?.addBusyCheck(() => state.entry?.session?.isBusy());
  const openHandler = ipc.handle('open-mcp-debug-panel', (event) => {
    const owner = deps.getMainWindow();
    if (!deps.isDevMode || !isHomeSender(event, owner?.webContents)) {
      return failure('DEV_MODE_REQUIRED', '仅开发模式首页可打开调试面板');
    }
    if (state.opening) return state.opening;
    if (state.entry) { state.entry.panel.show(); return success({ opened: true }); }
    state.opening = openPanel(owner, deps, state, view, preload)
      .catch((error) => failure('MCP_DEBUG_OPEN_FAILED', error.message)).finally(() => { state.opening = null; });
    return state.opening;
  });
  const requestHandler = registerPanelRequest(ipc, deps, state, viewUrl);
  return () => {
    removeDebugBusyCheck?.();
    state.entry?.panel.close();
    openHandler?.();
    requestHandler?.();
  };
}

module.exports = { isPanelSender, registerMcpDebugPanelIpc };

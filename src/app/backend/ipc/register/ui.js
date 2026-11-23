const { BrowserWindow, clipboard, nativeTheme, shell } = require('electron');
const { resolveTabTitle } = require('../../services/tab-common');
const { createBrowserDataClearController } = require('../../features/browser/browser-data-clear-controller');
const { createTabContextMenuController } = require('../../features/browser/tab-context-menu-controller');
const { createNetworkMagicPopupController } = require('../../features/network/network-magic-popup-controller');
const { createSidebarFocusHandler } = require('../../features/browser/sidebar-focus-controller');
const { updateMainWindowFrameTheme } = require('../../features/window/main-window-frame');
const { registerExternalMcpConfigIpc } = require('../../features/browser/register-external-mcp-config-ipc');
const {
  readWindowCloseBehavior,
  writeWindowCloseBehavior,
} = require('../../features/window/window-close-preference');
const {
  isStartupSupported,
  readStartupSettings,
  updateStartupSettings,
  withCloseBehaviorStartupSettings,
} = require('../../features/window/startup-preference');

function uiIpcError(error) {
  return error?.message || String(error);
}

function normalizeAppTheme(theme) {
  const value = String(theme || '').trim();
  return value === 'dark' || value === 'gold' ? value : 'light';
}

function sendThemeToContents(webContents, theme) {
  try {
    if (webContents && !webContents.isDestroyed()) webContents.send('app-theme-changed', theme);
  } catch (_) {}
}

function syncBrowserColorScheme(ui, theme) {
  const manager = ui?.browserRuntimeManager;
  if (typeof manager?.setPreferredColorScheme !== 'function') return;
  try {
    const syncTheme = manager.setPreferredColorScheme(theme);
    void syncTheme?.catch?.((error) => {
      console.warn('[ChromiumRuntime] 同步软件主题失败:', uiIpcError(error));
    });
  } catch (error) {
    console.warn('[ChromiumRuntime] 同步软件主题失败:', uiIpcError(error));
  }
}

function createThemeController(ui) {
  let currentTheme = 'light';
  return {
    current: () => currentTheme,
    broadcast(theme) {
      currentTheme = normalizeAppTheme(theme);
      try { if (nativeTheme) nativeTheme.themeSource = currentTheme === 'light' ? 'light' : 'dark'; } catch (_) {}
      syncBrowserColorScheme(ui, currentTheme);
      try {
        const mainWindow = ui?.getMainWindow?.();
        if (mainWindow && !mainWindow.isDestroyed()) {
          const backgrounds = { light: '#f6f9fd', gold: '#0c0b09', dark: '#0f1115' };
          mainWindow.setBackgroundColor(backgrounds[currentTheme]);
          sendThemeToContents(mainWindow.webContents, currentTheme);
          updateMainWindowFrameTheme(mainWindow, currentTheme);
        }
      } catch (_) {}
      try { ui?.sendToSide?.('app-theme-changed', currentTheme); } catch (_) {}
    },
  };
}

function getManagedTabs(ui) {
  return typeof ui?.getTabs === 'function' ? ui.getTabs() : new Map();
}

function getManagedActiveTabId(ui) {
  return typeof ui?.getActiveTabId === 'function' ? ui.getActiveTabId() : null;
}

function findManagedTabById(ui, tabId) {
  const id = String(tabId || '').trim();
  if (!id) return null;
  const tabs = getManagedTabs(ui);
  if (typeof tabs.get === 'function' && tabs.has(id)) return tabs.get(id);
  try {
    for (const tab of tabs.values()) {
      if (String(tab?.id || '').trim() === id) return tab;
    }
  } catch (_) {}
  return null;
}

function serializeManagedTab(ui, tab) {
  if (!tab) return null;
  const id = String(tab.id || '');
  return {
    id,
    appTabId: id,
    title: resolveTabTitle(tab),
    url: String(tab.runtimeUrl || ''),
    active: id === String(getManagedActiveTabId(ui) || ''),
    accountId: String(tab.accountId || '').trim(),
    runtimeType: 'chromium',
  };
}

function listManagedTabs(ui) {
  const tabs = Array.from(getManagedTabs(ui).values()).map((tab) => serializeManagedTab(ui, tab)).filter(Boolean);
  return {
    ok: true,
    activeTabId: String(getManagedActiveTabId(ui) || ''),
    tabs,
    activeTab: tabs.find((tab) => tab.active) || null,
  };
}

function normalizeBridgeUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('缺少 URL');
  if (value === 'about:blank') return value;
  try { return new URL(value).href; } catch (_) { return new URL(`https://${value}`).href; }
}

function createTabBridgeActions(ui) {
  const resultTabs = () => listManagedTabs(ui).tabs;
  return {
    'tab:identify': async ({ activeTab }) => ({ ok: true, tab: serializeManagedTab(ui, activeTab), tabs: resultTabs() }),
    'tab:list': async () => listManagedTabs(ui),
    'tab:switch': async ({ targetTab }) => {
      if (!targetTab?.id || typeof ui.switchTab !== 'function') return { ok: false, message: '目标标签不存在或无法切换' };
      ui.switchTab(targetTab.id);
      return { ok: true, action: 'switch', tab: serializeManagedTab(ui, targetTab), tabs: resultTabs() };
    },
    'tab:close': async ({ targetTab }) => {
      if (!targetTab?.id || typeof ui.closeTab !== 'function') return { ok: false, message: '目标标签不存在或无法关闭' };
      const closing = serializeManagedTab(ui, targetTab);
      await ui.closeTab(targetTab.id);
      return { ok: true, action: 'close', tab: closing, tabs: resultTabs() };
    },
    'tab:open': async ({ targetTab, payload }) => {
      if (typeof ui.addTab !== 'function') return { ok: false, message: '打开标签功能不可用' };
      const openedId = await ui.addTab(normalizeBridgeUrl(payload?.url), {
        browserSettings: targetTab?.browserSettings, runtimeType: 'chromium',
      });
      return { ok: true, action: 'open', tab: serializeManagedTab(ui, findManagedTabById(ui, openedId)), tabs: resultTabs() };
    },
    'tab:replace': async ({ targetTab, payload }) => {
      if (!targetTab?.id || !ui?.browserRuntimeManager) return { ok: false, message: '目标网页不可用' };
      if (typeof ui.switchTab === 'function') ui.switchTab(targetTab.id);
      await ui.browserRuntimeManager.navigate(targetTab.id, 'chromium', normalizeBridgeUrl(payload?.url));
      return { ok: true, action: 'replace', tab: serializeManagedTab(ui, targetTab), tabs: resultTabs() };
    },
    'tab:history': async () => ({ ok: false, message: '内置 Chromium 暂未开放前进/后退桥接' }),
    'tab:reload': async ({ targetTab }) => {
      if (!targetTab?.id || typeof ui.refreshTab !== 'function') return { ok: false, message: '目标网页不可用' };
      const result = await ui.refreshTab(targetTab.id);
      return result?.ok ? { ok: true, action: 'reload', tab: serializeManagedTab(ui, targetTab) } : result;
    },
    'tab:capture': async () => ({ ok: false, message: '请通过 Chromium 内的 AI-FREE 自动化扩展执行截图' }),
  };
}

function createTabBridgeHandler(ui) {
  const actions = createTabBridgeActions(ui);
  return async (_event, payload = {}) => {
    try {
      const command = String(payload?.command || payload?.action || '').trim();
      const activeTab = findManagedTabById(ui, getManagedActiveTabId(ui));
      const targetTab = findManagedTabById(ui, payload?.appTabId || payload?.tabId) || activeTab;
      const action = actions[command];
      if (!action) return { ok: false, message: `未知 MCP 浏览器桥接命令: ${command || '(empty)'}` };
      return action({ activeTab, targetTab, payload });
    } catch (error) {
      return { ok: false, message: uiIpcError(error) };
    }
  };
}

function registerBrowserRuntimeIPC(ipc, ui, clearController) {
  ipc.handle('get-browser-runtime-state', async (_event, payload = {}) => {
    const manager = ui?.browserRuntimeManager;
    if (!manager) return { ok: false, message: 'Browser Runtime 不可用' };
    const profileId = String(payload?.profileId || '').trim();
    return { ok: true, nativeHostAvailable: manager.isChromiumAvailable(), state: profileId ? manager.getState(profileId) : null, states: manager.listStates() };
  });
  ipc.handle('restart-browser-runtime', async (_event, payload = {}) => {
    const profileId = String(payload?.profileId || '').trim();
    if (!profileId || !ui?.browserRuntimeManager) return { ok: false, message: '缺少 Chromium Profile ID' };
    try {
      return {
        ok: true,
        state: await ui.browserRuntimeManager.restart(profileId, {
          compatibilityMode: payload?.compatibilityMode === true,
        }),
      };
    }
    catch (error) { return { ok: false, message: uiIpcError(error) }; }
  });
  ipc.handle('open-browser-diagnostics', async () => {
    const directory = ui?.browserRuntimeManager?.chromium?.launchOptions?.chromiumDiagnosticDir;
    if (!directory) return { ok: false, message: '诊断目录不可用' };
    try {
      const message = await shell.openPath(directory);
      return message ? { ok: false, message } : { ok: true };
    } catch (error) { return { ok: false, message: uiIpcError(error) }; }
  });
  ipc.handle('clear-browser-runtime-data', (event, payload) => clearController.request(event, payload));
  ipc.handle('resolve-browser-data-clear-confirm', (event, payload) => clearController.resolve(event, payload));
}

function registerTabIPC(ipc, ui, contextMenu) {
  ipc.on('add-tab', (_event, url) => ui.addTab(url));
  ipc.on('switch-tab', (_event, tabId) => ui.switchTab(tabId));
  ipc.on('close-tab', (_event, tabId) => { void ui.closeTab(tabId); });
  ipc.handle('show-tab-context-menu', async (event, payload = {}) => {
    try {
      const tabId = String(payload?.tabId || '').trim();
      if (!tabId) return { ok: false, message: '缺少标签 ID' };
      const opened = contextMenu.openTabContextMenuWindow({
        tabId,
        historyId: String(payload?.historyId || '').trim(),
        x: Number(payload?.x ?? 0),
        y: Number(payload?.y ?? 0),
        parentWindow: BrowserWindow.fromWebContents(event.sender),
      });
      return opened ? { ok: true } : { ok: false, message: '打开浏览器菜单失败' };
    } catch (error) { return { ok: false, message: uiIpcError(error) }; }
  });
  ipc.handle('get-tabs-state', async () => {
    try {
      const activeId = getManagedActiveTabId(ui);
      const tabs = Array.from(getManagedTabs(ui).values()).map((tab) => ({
        id: tab.id, title: resolveTabTitle(tab), isActive: tab.id === activeId, accountId: String(tab.accountId || '').trim(),
      }));
      return { ok: true, tabs };
    } catch (error) { return { ok: false, error: uiIpcError(error), tabs: [] }; }
  });
  ipc.handle('browser-mcp-bridge', createTabBridgeHandler(ui));
  ipc.handle('refresh-tab', async (_event, tabId) => {
    try { return ui.refreshTab ? ui.refreshTab(tabId) : { ok: false, message: '刷新功能不可用' }; }
    catch (error) { return { ok: false, message: uiIpcError(error) }; }
  });
  ipc.on('reorder-tab', (_event, payload = {}) => {
    try { ui.reorderTab?.(payload.tabId, payload.targetTabId, payload.position); } catch (_) {}
  });
}

function readSidebarWidth(sideView) {
  if (!sideView || sideView.getVisible?.() === false) return 0;
  const bounds = sideView.getBounds?.();
  return Number(bounds?.width) || 0;
}

function openHomeAccountCenter(ui) {
  const contents = ui.getMainWindow?.()?.webContents;
  if (!contents || contents.isDestroyed?.()) return;
  const open = () => {
    if (contents.isDestroyed?.()) return;
    ui.switchTab(null);
    ui.revealMainWindow?.();
    contents.focus?.();
    contents.send('open-account-center');
  };
  if (contents.isLoadingMainFrame?.()) contents.once('did-finish-load', open);
  else open();
}

function alignedStartupPayload(ctx, overrides = {}) {
  const current = readStartupSettings(ctx.readStoreConfigSafe, ctx.app);
  return withCloseBehaviorStartupSettings(
    { ...current, ...overrides },
    readWindowCloseBehavior(ctx.readStoreConfigSafe),
  );
}

function registerStartupPreferenceIPC(ipc, ctx) {
  ipc.handle('get-startup-settings', async () => ({
    ok: true,
    data: {
      ...alignedStartupPayload(ctx),
      supported: isStartupSupported(ctx.app, process.platform),
    },
  }));
  ipc.handle('set-startup-settings', async (_event, payload = {}) => (
    updateStartupSettings({
      app: ctx.app,
      readStoreConfigSafe: ctx.readStoreConfigSafe,
      writeStoreConfigSafe: ctx.writeStoreConfigSafe,
      payload: alignedStartupPayload(ctx, { openAtLogin: payload?.enabled === true }),
      options: { platform: process.platform, execPath: process.execPath },
    })
  ));
}

function registerWindowPreferencesIPC(ipc, ctx) {
  ipc.handle('get-window-close-behavior', async () => ({
    ok: true,
    data: { behavior: readWindowCloseBehavior(ctx.readStoreConfigSafe) },
  }));
  ipc.handle('set-window-close-behavior', async (_event, payload = {}) => {
    const saved = writeWindowCloseBehavior(
      ctx.readStoreConfigSafe,
      ctx.writeStoreConfigSafe,
      String(payload?.behavior || ''),
    );
    if (!saved.ok) return saved;
    const current = readStartupSettings(ctx.readStoreConfigSafe, ctx.app);
    const aligned = withCloseBehaviorStartupSettings(current, saved.data?.behavior);
    if (current.startMinimized !== aligned.startMinimized) {
      const synced = updateStartupSettings({
        app: ctx.app,
        readStoreConfigSafe: ctx.readStoreConfigSafe,
        writeStoreConfigSafe: ctx.writeStoreConfigSafe,
        payload: aligned,
        options: { platform: process.platform, execPath: process.execPath },
      });
      if (!synced.ok) return synced;
    }
    return saved;
  });
  registerStartupPreferenceIPC(ipc, ctx);
}

function registerUiUtilityIPC(ipc, ctx) {
  const { ui } = ctx;
  ipc.handle('set-sidebar-width', async (event, payload = {}) => {
    const sideView = ui.getSideView?.();
    const sideContents = sideView?.webContents;
    if (payload.width === undefined) {
      return { ok: true, width: readSidebarWidth(sideView) };
    }
    if (!sideContents || sideContents.isDestroyed?.() || sideContents.id !== event.sender?.id) {
      return { ok: false, message: '当前页面不是内嵌侧边栏' };
    }
    const width = ui.setSidebarWidth?.(payload.width) || 0;
    return width > 0 ? { ok: true, width } : { ok: false, message: '侧边栏当前不可调整' };
  });
  ipc.on('set-ui-scale', (_event, payload = {}) => {
    ui.setUiScale?.(payload.scale);
  });
  registerWindowPreferencesIPC(ipc, ctx);
  ipc.on('toggle-sidebar', () => ui.toggleSidebar());
  const networkMagicPopup = createNetworkMagicPopupController({ ui });
  ipc.on('toggle-network-magic-panel', (event, payload = {}) => {
    if (event.sender === ui.getMainWindow?.()?.webContents) {
      networkMagicPopup.toggle(payload);
    } else if (event.sender === networkMagicPopup.getWindow()?.webContents) {
      if (payload?.open === true) networkMagicPopup.resize(payload);
      else networkMagicPopup.close();
    }
  });
  ipc.on('ensure-sidebar-visible', () => ui.ensureSidebarVisible?.());
  ipc.on('request-account-center', (event) => {
    const popup = networkMagicPopup.getWindow();
    if (popup && popup.webContents.id === event.sender?.id) networkMagicPopup.close();
    openHomeAccountCenter(ui);
  });
  ipc.on('request-home-model-settings', (event) => {
    const side = ui.getSideView?.()?.webContents;
    const main = ui.getMainWindow?.()?.webContents;
    if (!side || side.isDestroyed?.() || event.sender !== side || event.senderFrame !== side.mainFrame) return;
    if (!main || main.isDestroyed?.()) return;
    const open = () => {
      if (main.isDestroyed?.()) return;
      ui.switchTab(null);
      ui.revealMainWindow?.();
      main.send('open-home-model-settings');
    };
    if (main.isLoadingMainFrame?.()) main.once('did-finish-load', open);
    else open();
  });
  ipc.handle('open-active-web-console', async () => {
    try {
      const contents = ui.getActiveWC?.();
      if (!contents || contents.isDestroyed?.()) return { ok: false, message: '当前没有可查看控制台的网页' };
      if (contents.isDevToolsOpened?.()) {
        try { contents.devToolsWebContents?.focus?.(); } catch (_) {}
        return { ok: true, opened: true, alreadyOpen: true };
      }
      contents.openDevTools({ mode: 'detach' });
      return { ok: true, opened: true, alreadyOpen: false };
    } catch (error) { return { ok: false, message: uiIpcError(error) }; }
  });
  ipc.on('reveal-cookie-import', () => {
    try { ui.sendToSide?.('cookie-import-unlock'); ui.ensureSidebarVisible?.(); } catch (_) {}
  });
  ipc.on('set-zoom', (_event, zoomFactor) => ui.setZoom(zoomFactor));
  ipc.on('refresh-active-tab-to-url', (_event, url) => ui.refreshActiveTabToUrl(url));
  ipc.on('refresh-active-tab', () => ui.refreshActiveTab());
  ipc.on('smart-refresh-active-tab', async () => {
    try {
      const contents = ui.getActiveWC?.();
      if (!contents || contents.isDestroyed?.()) return;
      const url = contents.getURL?.() || '';
      if (String(url).startsWith('https://dreamina.capcut.com/ai-tool/')) {
        const targetUrl = typeof ctx.getDreamTargetUrl === 'function' ? ctx.getDreamTargetUrl() : ctx.DREAM_TARGET_URL;
        ui.refreshActiveTabToUrl(targetUrl);
      } else ui.refreshActiveTab();
    } catch (_) {}
  });
  ipc.handle('focus-sidebar-input', createSidebarFocusHandler(ui));
  ipc.on('open-tutorial', (_event, url) => { void ui?.openTutorialTab?.(url); });
}

function registerUiIPC(ctx) {
  const ipc = ctx.ipc.scope('register/ui');
  const contextMenu = createTabContextMenuController();
  const theme = createThemeController(ctx.ui);
  const clearController = createBrowserDataClearController(ctx.ui, contextMenu.closeTabContextMenuWindow);
  registerBrowserRuntimeIPC(ipc, ctx.ui, clearController);
  ipc.on('app-theme-changed', (_event, nextTheme) => theme.broadcast(nextTheme));
  ipc.handle('get-app-theme', async () => ({ ok: true, theme: theme.current() }));
  registerTabIPC(ipc, ctx.ui, contextMenu);
  registerUiUtilityIPC(ipc, ctx);
  registerExternalMcpConfigIpc(ipc, ctx, (text) => clipboard.writeText(text));
}

module.exports = { registerUiIPC };

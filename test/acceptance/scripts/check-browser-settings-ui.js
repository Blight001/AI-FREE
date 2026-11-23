const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { attachContextMenu } = require('../../../src/app/backend/utils/removeWatermark');
const { applicationLayout, runtimeArgument } = require('../../helpers/flows/app-layout');
const { accountPreferencesDrivers } = require('../../helpers/flows/account-preferences');
const { homeWorkspaceDrivers, checkBrowserHistoryResize } = require('../../helpers/flows/home-workspace');
const { checkProviderAccountDialog, bindProviderAccountFixture } = require('../../helpers/electron/provider-account-dialog');
const { checkHomeAccountIntegration, checkVipShopOnly } = require('../../helpers/electron/home-account-integration');
const { checkHomeTheme } = require('../../helpers/electron/home-theme');
const { checkNetworkMagicPopup, checkNetworkMagicLauncher } = require('../../helpers/electron/network-magic-popup');
const { checkHomeDialogScope } = require('../../helpers/electron/home-dialog-scope');
const { checkHomeConsole } = require('../../helpers/electron/home-console');
const { createAutomationUiFixture, checkHomeAutomationEditor } = require('../../helpers/electron/home-automation-editor');
const { checkHomeMcp } = require('../../helpers/electron/home-mcp');
const { runFlow } = require('../../helpers/flows/runner');
const { emitFlowReport } = require('../../../scripts/verification/flow-reports');
const appOutIndex = process.argv.indexOf('--app-out-dir');
const layout = applicationLayout(runtimeArgument(process.argv, 'source'), {
  appOutDir: appOutIndex < 0 ? undefined : process.argv[appOutIndex + 1],
});
const performanceProbeStartedAt = process.hrtime.bigint();

let browserHistoryOpenRequests = 0;
const browserDataClearConfirmations = [];
let homeSwitchRequests = 0;
let independentBrowserCreateRequests = 0;
let accountSessionRequests = 0;
let accountCenterRequests = 0;
let mcpCopyRequests = 0;
let accountSession = { authenticated: false };
let windowCloseBehavior = 'ask';
let startupSettings = { openAtLogin: false, startMinimized: false };
let customModels = [];
let discoveredModelRequest = null;
let savedModelPayload = null;
let aiPreferencesEnabled = false;
let fixtureLastModelId = '';
const fixtureHistory = [
  { id: 'newer', title: 'Newer', updatedAt: 4, pinnedAt: 0 },
  { id: 'older', title: 'Older', updatedAt: 2, pinnedAt: 0 },
];
require('../../helpers/electron/site-data').bindSiteDataFixture(ipcMain, () => BrowserWindow.getAllWindows()[0], layout.root);
ipcMain.handle('open-browser-history', (_event, payload = {}) => {
  browserHistoryOpenRequests += 1;
  return { ok: true, historyId: payload.historyId, name: '平台 A' };
});
ipcMain.on('switch-tab', (_event, tabId) => {
  if (tabId === null) homeSwitchRequests += 1;
});
ipcMain.handle('create-independent-browser', () => {
  independentBrowserCreateRequests += 1;
  return { ok: true, pending: false, tabId: 'acceptance-browser', historyId: 'acceptance-history' };
});
ipcMain.handle('get-app-version', () => ({ ok: true, version: '2.6.38' }));
ipcMain.handle('account-get-session', () => {
  accountSessionRequests += 1;
  return accountSession;
});
ipcMain.on('request-account-center', () => { accountCenterRequests += 1; });
ipcMain.handle('get-window-close-behavior', () => ({ ok: true, data: { behavior: windowCloseBehavior } }));
ipcMain.handle('set-window-close-behavior', (_event, payload = {}) => {
  windowCloseBehavior = String(payload.behavior || '');
  return { ok: true, data: { behavior: windowCloseBehavior } };
});
ipcMain.handle('get-startup-settings', () => ({ ok: true, data: startupSettings }));
ipcMain.handle('set-startup-settings', (_event, payload = {}) => {
  startupSettings = {
    openAtLogin: payload.enabled === true,
    startMinimized: payload.enabled === true && windowCloseBehavior === 'hide',
  };
  return { ok: true, data: startupSettings };
});
ipcMain.handle('ai-control-custom-models-list', () => ({ ok: true, models: customModels }));
ipcMain.handle('ai-control-get-models', () => ({ ok: true, quota: null, lastModelId: fixtureLastModelId,
  models: aiPreferencesEnabled ? [{ id: 'first', name: 'First' }, { id: 'second', name: 'Second', custom_api: true }] : [] }));
ipcMain.handle('ai-control-set-last-model', (_event, { modelId }) => {
  fixtureLastModelId = modelId;
  return { ok: true, data: { modelId } };
});
ipcMain.handle('ai-control-managed-chat', () => ({ ok: true, data: { sessions: [] } }));
ipcMain.handle('ai-control-history-list', () => ({ ok: true, sessions: aiPreferencesEnabled ? fixtureHistory : [] }));
ipcMain.handle('ai-control-history-pin', (_event, { id, pinned }) => {
  const session = fixtureHistory.find((item) => item.id === id);
  session.pinnedAt = pinned ? Date.now() : 0;
  return { ok: true, data: { id, pinnedAt: session.pinnedAt } };
});
ipcMain.handle('ai-control-custom-model-discover', (_event, payload) => {
  discoveredModelRequest = payload;
  return { ok: true, models: [{ id: 'fixture-chat', name: 'Fixture Chat' }, { id: 'fixture-reasoner', name: 'Fixture Reasoner' }] };
});
ipcMain.handle('ai-control-custom-model-save-many', (_event, payload) => {
  savedModelPayload = payload;
  customModels = payload.models.map(({ apiKey, ...model }, index) => ({
    ...model,
    id: `__custom_openai_api__:acceptance-${index}`,
    hasApiKey: Boolean(apiKey),
  }));
  return { ok: true, models: customModels };
});
ipcMain.handle('get-external-codex-status', () => ({
  ok: true,
  data: { published: true, ready: true, membershipRequired: false, toolCount: 0, connectionCount: 0 },
}));
ipcMain.handle('copy-external-codex-config', () => {
  mcpCopyRequests += 1;
  return { ok: true, data: { mode: 'streamable-http' } };
});
ipcMain.handle('get-ai-free-browser-settings', () => ({
  ok: true,
  settings: require('../../../src/app/backend/utils/ai-free-browser-settings').normalizeAiFreeBrowserSettings({}),
  runtimeInfo: { chromiumVersion: process.versions.chrome, electronVersion: process.versions.electron },
  activeTab: null,
}));
ipcMain.handle('set-sidebar-width', () => ({ ok: true, width: 280 }));
ipcMain.handle('clear-browser-runtime-data', (event, payload = {}) => {
  const requestId = `ui-clear-${browserDataClearConfirmations.length + 1}`;
  event.sender.send('browser-data-clear-confirm-request', {
    requestId, profileId: payload.profileId, title: '平台 A',
  });
  return { ok: true, pending: true };
});
ipcMain.handle('resolve-browser-data-clear-confirm', (_event, payload = {}) => {
  browserDataClearConfirmations.push({ requestId: payload.requestId, confirmed: payload.confirmed === true });
  return { ok: true, cancelled: payload.confirmed !== true };
});
const automationUi = createAutomationUiFixture(layout);
ipcMain.handle('ai-control-manage-automation-card', (_event, input) => automationUi.handle(input));
for (const [channel, response] of /** @type {Array<[string, any]>} */ ([
  ['get-extension-manager-state', {
    ok: true,
    state: {
      developerModeEnabled: true,
      plugins: [
        {
          id: 'translate',
          name: '翻译插件',
          description: '把网页内容翻译成中文，适合对照阅读长文。',
          hint: '点击网页右侧粉色按钮翻译',
          version: '1.2.0',
          enabled: true,
          builtin: true,
        },
        {
          id: 'remove-watermark',
          name: '去水印插件',
          description: '右键保存视频和图片时自动去掉水印。',
          hint: '右键视频图片直接下载',
          version: '1.0.0',
          enabled: true,
          builtin: true,
        },
      ],
    },
  }],
  ['get-clash-mini-status', { running: false }],
  ['get-user-credentials', { ok: true, credentials: {} }],
  ['get-all-accounts', []],
  ['get-target-url', 'https://www.baidu.com/'],
  ['get-platform-name', 'AI-FREE'],
  ['get-wool-platforms', [{ name: 'AI-FREE', targetUrl: 'https://www.baidu.com/' }]],
  ['refresh-wool-platforms', { ok: true, platforms: [] }],
  ['get-tutorial-url', 'https://www.baidu.com/'],
  ['consume-auto-validate-flag', { pending: false }],
  ['get-network-magic-auto-start-enabled', { ok: true, enabled: false }],
  ['get-network-magic-proxy-mode', { ok: true, mode: 'port' }],
  ['get-browser-history', {
    ok: true,
    capacity: { snapshot: { activeProfiles: 1, profileLimit: 5, pressure: 'normal' } },
    profileAudit: { totalCount: 13 },
    history: [{
      id: 'shared-browser',
      profileId: 'shared-browser-profile',
      name: '平台 A',
      accountDisplayName: '账号123456',
      accountType: 'shared',
      accountTypeLabel: '循环账号',
      autoDeleteAt: 2_000_000_000_000,
      isOpen: false,
      isActive: false,
      lastOpenedAt: 1_900_000_000_000,
    }, ...Array.from({ length: 24 }, (_, index) => ({
      id: `fixture-browser-${index}`,
      name: `Fixture browser ${index + 1}`,
      isOpen: index < 3,
      isActive: index === 1,
      lastError: index === 2 ? 'Fixture error' : undefined,
      lastOpenedAt: 1_800_000_000_000 - index,
    }))],
  }],
  ['get-proxy-traffic-quota', { ok: false }],
  ['ai-control-get-browser-connections', {
    ok: true,
    connections: [],
    mcpTools: [
      { name: 'run_command', description: '运行命令' },
      automationUi.browserAction,
    ],
  }],
  ['ai-control-workspace-list', { ok: true, rootName: 'AI-Workspace', files: [], truncated: false }],
  ['ai-control-get-automation-cards', { ok: true, cards: [], selectedId: '' }],
  ['get-ai-control-custom-api', { ok: true, config: {} }],
  ['get-ai-server-device-status', {
    ok: true,
    status: {
      phase: 'idle', server: 'http://49.234.181.190:58150', account: '',
      serviceName: 'AI-FREE', connected: false, registered: false,
      serviceId: '', toolCount: 0, aiConfigId: null, message: '尚未连接 AI 服务器',
    },
  }],
  ['get-vip-plans', {
    ok: true,
    tiers: [{ tier: 'vip', display_name: 'VIP' }],
    plans: [{ code: 'vip_quarterly', tier: 'vip', billing_cycle: 'quarterly', name: 'VIP 包季', price_cents: 4990, duration_days: 90 }],
    permission_comparison: [
      { code: 'browser_limit', name: '独立浏览器窗口', free: '最多 5 个', vip: '不限数量' },
      { code: 'extension_import', name: '自定义插件', free: '不可导入', vip: '允许导入' },
      { code: 'legacy_feature', name: '自定义模型', free: '不可添加', vip: '允许添加' },
      { code: 'weekly_ai_quota', name: '每周 AI 额度', free: '无赠送', vip: '200 点' },
    ],
  }],
  ['focus-sidebar-input', { ok: true }],
])) ipcMain.handle(channel, () => response);

async function checkScenario(defaultScenario, fixture) {
  const index = process.argv.indexOf('--scenario');
  const scenario = index < 0 ? defaultScenario : JSON.parse(fs.readFileSync(process.argv[index + 1], 'utf8'));
  const result = await runFlow(scenario, fixture);
  emitFlowReport(result);
  if (!result.ok) throw new Error(`${scenario.id}: ${JSON.stringify(result.data.steps.at(-1))}`);
}

function checkAccountPreferences(win) {
  return checkScenario(require('../flows/account-preferences.json'), accountPreferencesDrivers(win, layout.pages.shell,
    () => ({ closeBehavior: windowCloseBehavior, ...startupSettings })));
}

async function clickTaskbarCorner(contents, expectedRequests) {
  const target = await contents.executeJavaScript(`(() => {
    const home = document.getElementById('home-tab-btn');
    const { width, height } = home.getBoundingClientRect();
    const radius = getComputedStyle(home).borderTopLeftRadius;
    const radiusPx = parseFloat(radius) * (radius.endsWith('%') ? width / 100 : 1);
    return { x: 0, y: innerHeight - 1, square: width > 0 && width === height && radiusPx < width / 4 };
  })()`);
  if (!target.square) throw new Error('Expected a square taskbar home button');
  const { x, y } = target;
  const before = homeSwitchRequests;
  await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (const type of ['mousePressed', 'mouseReleased']) {
    await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  if (homeSwitchRequests !== before + expectedRequests) {
    throw new Error(`Expected ${expectedRequests} Home switch requests, got ${homeSwitchRequests - before}`);
  }
}

async function checkHomeButtonPreservesEditor(contents) {
  await contents.executeJavaScript(`(() => {
    document.getElementById('home-automation-tab').click();
    document.getElementById('automation-create').click();
    document.getElementById('automation-editor-name').value = '未保存的流程';
  })()`);
  try {
    await clickTaskbarCorner(contents, 0);
    const preserved = await contents.executeJavaScript(`(() => {
      return document.getElementById('automation-editor').open
        && document.getElementById('automation-editor-name').value === '未保存的流程'
        && document.getElementById('home-automation-tab').getAttribute('aria-selected') === 'true';
    })()`);
    if (!preserved) throw new Error('Home click discarded the open editor or its draft');
  } finally {
    await contents.executeJavaScript(`(() => {
      document.getElementById('automation-editor-close').click();
      document.getElementById('home-browsers-tab').click();
    })()`);
  }
}

async function checkTaskbarHomeButton(win) {
  const contents = win.webContents;
  contents.debugger.attach();
  try {
    await checkHomeButtonPreservesEditor(contents);
    contents.send('update-tabs', Array.from({ length: 16 }, (_, index) => ({
      id: `corner-fixture-${index}`, title: `Browser ${index + 1}`, runtimeStatus: 'ready', isActive: index === 0,
    })));
    const scrolled = await contents.executeJavaScript(`(async () => {
      const tabs = document.getElementById('tabs-container');
      for (let attempt = 0; attempt < 50; attempt += 1) {
        tabs.scrollLeft = tabs.scrollWidth;
        if (tabs.scrollLeft > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    })()`);
    if (!scrolled) throw new Error('Expected overflow tabs to scroll');
    const [activeTitle, inactiveTitle] = await contents.executeJavaScript(`(() => {
      const readTitleStyle = (selector) => {
        const title = document.querySelector(selector);
        const { fontSize, fontWeight } = getComputedStyle(title);
        return { fontSize, fontWeight: Number(fontWeight) };
      };
      return [readTitleStyle('.tab.active .tab-title'), readTitleStyle('.tab:not(.active) .tab-title')];
    })()`);
    assert.equal(activeTitle.fontSize, inactiveTitle.fontSize, 'Selecting a browser tab must not enlarge its title');
    assert.equal(activeTitle.fontWeight, inactiveTitle.fontWeight, 'Browser tab titles should use the same inherited weight');
    await clickTaskbarCorner(contents, 1);
  } finally {
    contents.send('update-tabs', []);
    contents.debugger.detach();
  }
}

async function checkNewWindowButtonHover(contents) {
  const readButton = `(() => {
    const button = document.getElementById('new-browser-window-btn');
    // The hidden test window may not tick CSS transitions.
    for (const animation of button.getAnimations({ subtree: true })) animation.finish();
    const bounds = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return {
      bounds: bounds.toJSON(),
      iconBounds: button.querySelector('svg').getBoundingClientRect().toJSON(),
      background: style.backgroundColor,
      hovered: button.matches(':hover'),
    };
  })()`;
  contents.debugger.attach();
  try {
    await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
    const before = await contents.executeJavaScript(readButton);
    const { x, y, width, height } = before.bounds;
    await contents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: x + width / 2, y: y + height / 2,
    });
    const after = await contents.executeJavaScript(readButton);
    if (!after.hovered || before.background === after.background) {
      throw new Error(`Expected the new window button to highlight on hover: ${JSON.stringify({ before, after })}`);
    }
    if (JSON.stringify(before.bounds) !== JSON.stringify(after.bounds)
      || JSON.stringify(before.iconBounds) !== JSON.stringify(after.iconBounds)) {
      throw new Error('Expected the new window button and icon to stay stationary on hover');
    }
  } finally {
    contents.debugger.detach();
  }
}

async function checkMainWindowFrame() {
  if (process.platform !== 'win32') return;
  const { mainWindowFrameOptions } = require(path.join(layout.root, 'src/app/backend/features/window/main-window-frame.js'));
  const win = new BrowserWindow({ show: false, width: 1000, height: 700, ...mainWindowFrameOptions() });
  const keepAlive = () => {};
  app.on('window-all-closed', keepAlive);
  try {
    await win.loadFile(layout.pages.shell);
    win.showInactive();
    async function assertGeometry() {
      const state = await win.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => {
        const overlay = navigator.windowControlsOverlay;
        const strip = document.getElementById('shell-title-bar');
        resolve({
          visible: overlay.visible, overlayHeight: overlay.getTitlebarAreaRect().height,
          pageTop: document.getElementById('browser-page-module').getBoundingClientRect().top,
          stripWidth: strip.getBoundingClientRect().width, viewportWidth: innerWidth,
          draggable: getComputedStyle(strip).getPropertyValue('app-region'),
          text: strip.textContent, imageCount: strip.querySelectorAll('img').length,
        });
      }))`);
      assert.equal(state.visible, true, JSON.stringify(state));
      assert.equal(state.overlayHeight, 32);
      assert.equal(state.pageTop, state.overlayHeight);
      assert.ok(state.stripWidth > 0 && state.stripWidth < state.viewportWidth);
      assert.equal(state.draggable, 'drag');
      assert.equal(state.text, '');
      assert.equal(state.imageCount, 0);
    }
    await assertGeometry();
    win.maximize();
    await assertGeometry();
    win.unmaximize();
    await assertGeometry();
  } finally {
    win.destroy();
    app.off('window-all-closed', keepAlive);
  }
  console.log(`main window title bar checks passed (${layout.runtime})`);
}

app.whenReady().then(async () => {
  if (process.argv.includes('--title-bar-only')) {
    await checkMainWindowFrame();
    app.quit();
    return;
  }
  const themeOnly = process.argv.includes('--theme-only');
  const vipShopOnly = process.argv.includes('--vip-shop-only');
  const automationOnly = process.argv.includes('--automation-editor-only');
  if (!themeOnly && !vipShopOnly && !automationOnly) await checkMainWindowFrame();
  const win = new BrowserWindow({
    width: 805,
    height: 1200,
    show: !!process.env.AI_FREE_UI_CAPTURE,
    webPreferences: {
      contextIsolation: true,
      // The hidden fixture still asserts animation frames and transitions.
      backgroundThrottling: false,
      preload: path.join(layout.root, 'src/app/backend/preload.js'),
    },
  });
  if (vipShopOnly) {
    ipcMain.handle('provider-categories-list', () => ({ ok: true, data: { categories: [] } }));
    try {
      win.setSize(760, 460);
      await checkVipShopOnly(win, layout);
      console.log(`VIP shop UI checks passed (${layout.runtime})`);
    } finally {
      ipcMain.removeHandler('provider-categories-list');
      win.destroy();
    }
    app.quit();
    return;
  }
  if (themeOnly) {
    ipcMain.handle('provider-categories-list', () => ({ ok: true, data: { categories: [] } }));
  } else {
    bindProviderAccountFixture(layout, win.webContents);
  }
  if (automationOnly) {
    try { await checkHomeAutomationEditor(win, layout, automationUi); } finally { win.destroy(); }
    app.quit();
    return;
  }
  if (process.argv.includes('--mcp-only')) {
    try {
      await checkHomeMcp(win, layout);
      console.log(`home MCP UI checks passed (${layout.runtime})`);
    } finally {
      win.destroy();
    }
    app.quit();
    return;
  }
  if (process.argv.includes('--console-only')) {
    try {
      await checkHomeConsole(win, layout);
      console.log(`home console UI checks passed (${layout.runtime})`);
    } finally {
      win.destroy();
    }
    app.quit();
    return;
  }
  if (process.argv.includes('--account-only')) {
    try {
      await win.loadFile(layout.pages.shell);
      await checkAccountPreferences(win);
    } finally {
      win.destroy();
    }
    app.quit();
    return;
  }
  attachContextMenu(win.webContents);
  await win.loadFile(layout.pages.shell);
  if (process.argv.includes('--network-magic-only')) {
    await checkNetworkMagicLauncher(win);
    await checkNetworkMagicPopup(win, layout);
    console.log(`network magic popup checks passed (${layout.runtime})`);
    win.destroy();
    app.quit();
    return;
  }
  await checkHomeTheme(win);
  if (themeOnly) {
    win.destroy();
    console.log(`home appearance UI checks passed (${layout.runtime})`);
    app.quit();
    return;
  }
  if (process.argv.includes('--site-data-only')) {
    const home = require('../flows/home-workspace.json');
    const start = home.steps.findIndex(step => step.id === 'openSites');
    const end = home.steps.findIndex(step => step.id === 'editorClosed');
    await checkScenario({ ...home, id: 'site-data-workspace', steps: home.steps.slice(start, end + 1) },
      homeWorkspaceDrivers(win.webContents, () => ({ count: accountCenterRequests })));
    win.destroy();
    app.quit();
    return;
  }
  await checkProviderAccountDialog(win.webContents);
  if (process.argv.includes('--provider-accounts-only')) {
    win.destroy();
    console.log(`provider account dialog UI checks passed (${layout.runtime})`);
    app.quit();
    return;
  }
  await checkHomeDialogScope(win.webContents);
  const clearConfirmDeadline = Date.now() + 1000;
  while (!browserDataClearConfirmations.length && Date.now() < clearConfirmDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(browserDataClearConfirmations.map((item) => item.confirmed), [false]);
  if (process.argv.includes('--home-dialogs-only')) {
    win.destroy();
    app.quit();
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 120));
  const firstSidebarReadyMs = Number(process.hrtime.bigint() - performanceProbeStartedAt) / 1e6;
  await checkNewWindowButtonHover(win.webContents);
  await checkTaskbarHomeButton(win);
  await checkBrowserHistoryResize(win);
  await checkScenario(require('../flows/home-workspace.json'),
    homeWorkspaceDrivers(win.webContents, () => ({ count: accountCenterRequests })));
  accountCenterRequests = 0;
  if (process.argv.includes('--home-only')) {
    await checkHomeConsole(win, layout);
    win.destroy();
    console.log(`home workspace UI checks passed (${layout.runtime})`);
    app.quit();
    return;
  }
  const result = await win.webContents.executeJavaScript(`(async () => {
    const initialDefault = {
      settingsActive: document.getElementById('ai-free-settings-panel')?.classList.contains('active') === true,
      settingsTabRemoved: !document.querySelector('[data-tab="ai-free-settings-panel"]'),
      aiPanelRemoved: !document.getElementById('ai-control-panel'),
    };
    const navButtons = Array.from(document.querySelectorAll('.tab-nav .tab-button'));
    const navTops = navButtons.map((button) => Math.round(button.getBoundingClientRect().top));
    document.getElementById('browser-settings-create-browser')?.click();
    await redirectToAccountLogin();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await new Promise((resolve) => setTimeout(resolve, 120));
    const panel = document.getElementById('ai-free-settings-panel');
    const settingsForm = document.getElementById('ai-free-settings-form');
    const labels = Array.from(settingsForm.querySelectorAll('.vb-label')).map((item) => item.textContent.trim());
    const animationProbe = buildVpnNodeSelectorButton('动画测试节点', 0, { delay: null }, '');
    document.getElementById('vpn-node-selector-grid')?.appendChild(animationProbe);
    const nodeAnimationName = getComputedStyle(animationProbe).animationName;
    animationProbe.remove();
    const magicToggle = document.getElementById('shell-network-magic-toggle');
    const vpnButton = document.getElementById('VPN-switch');
    const vpnButtonOriginal = {
      busy: vpnButton?.dataset.busy,
      disabled: vpnButton?.disabled,
      text: vpnButton?.textContent,
    };
    if (vpnButton) {
      vpnButton.dataset.busy = '1';
      vpnButton.disabled = true;
      vpnButton.textContent = '正在开启魔法请稍等';
    }
    const vpnBusyStyle = vpnButton ? getComputedStyle(vpnButton) : null;
    const vpnAutoStartBusyAppearance = !vpnButton || (vpnButton?.textContent === '正在开启魔法请稍等'
      && vpnButton.disabled === true
      && vpnBusyStyle?.backgroundImage === 'none'
      && vpnBusyStyle?.cursor === 'wait');
    if (vpnButton) {
      if (vpnButtonOriginal.busy === undefined) delete vpnButton.dataset.busy;
      else vpnButton.dataset.busy = vpnButtonOriginal.busy;
      vpnButton.disabled = vpnButtonOriginal.disabled;
      vpnButton.textContent = vpnButtonOriginal.text;
    }
    const nodeToggle = document.getElementById('vpn-node-selector-toggle-btn');
    const nodePanel = document.getElementById('vpn-node-selector-panel');
    const nodePanelCollapsedByDefault = !nodePanel || (nodePanel.hidden === true
      && nodeToggle?.getAttribute('aria-expanded') === 'false');
    const nodeToggleWasDisabled = nodeToggle?.disabled === true;
    const nodeToggleVisible = !nodeToggle || nodeToggle.getBoundingClientRect().width > 0;
    if (nodeToggle) nodeToggle.disabled = false;
    nodeToggle?.click();
    const nodePanelOpenedByToggle = !nodePanel || (nodePanel.hidden === false
      && nodeToggle?.getAttribute('aria-expanded') === 'true');
    if (nodeToggle) nodeToggle.disabled = nodeToggleWasDisabled;
    await new Promise((resolve) => setTimeout(resolve, 20));
    document.getElementById('home-plugins-tab').click();
    const extensionList = document.getElementById('extension-plugin-list');
    const extensionReadyStartedAt = Date.now();
    while (extensionList?.textContent.includes('正在读取统一插件') && Date.now() - extensionReadyStartedAt < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const extensionItems = Array.from(document.querySelectorAll('.extension-plugin-item'));
    const flexWrap = extensionList ? getComputedStyle(extensionList).flexWrap : '';
    const extensionListBox = extensionList?.getBoundingClientRect();
    const firstExtensionBox = extensionItems[0]?.getBoundingClientRect();
    const secondExtensionBox = extensionItems[1]?.getBoundingClientRect();
    const firstExtensionWidth = firstExtensionBox?.width || 0;
    const extensionsShareRow = !!firstExtensionBox && !!secondExtensionBox
      && Math.abs(firstExtensionBox.top - secondExtensionBox.top) < 8
      && secondExtensionBox.left > firstExtensionBox.right - 1;
    const detailsBtn = document.querySelector('.extension-plugin-details');
    const detailsBody = document.querySelector('.extension-plugin-detail-body');
    const detailsHiddenBefore = detailsBody?.hidden === true;
    detailsBtn?.click();
    const detailsOpened = detailsBody?.hidden === false
      && (detailsBody?.textContent || '').includes('把网页内容翻译成中文');
    document.getElementById('home-browsers-tab').click();
    const automationWorkbenchRemoved = !document.getElementById('automation-workbench-dialog')
      && !document.getElementById('automation-workbench')
      && !document.getElementById('automation-workbench-open')
      && !document.querySelector('.automation-workbench-launcher')
      && !document.getElementById('automation-flow-canvas');
    const providerTabs = [...document.querySelectorAll('#home-accounts .provider-account-tabs [role="tab"]')];
    const providerPanels = [...document.querySelectorAll('#home-accounts [data-provider]')];
    const providerTabsReady = providerTabs.length === 2
      && providerTabs[0].textContent.includes('Google')
      && providerTabs[1].textContent.includes('Microsoft')
      && !!document.querySelector('#provider-account-form [name="password"]')
      && !!document.querySelector('#provider-account-form [name="note"]');
    providerTabs[1]?.click();
    const providerSwitchWorks = providerTabs[1]?.getAttribute('aria-selected') === 'true'
      && providerPanels[1]?.hidden === false && providerPanels[0]?.hidden === true;
    providerTabs[0]?.click();
    return {
      active: panel.classList.contains('active'),
      dedicatedSettingsPage: document.documentElement.classList.contains('browser-settings-page'),
      sidebarNavigationRemoved: !document.querySelector('.tab-nav'),
      configHomeLogoVisible: !!document.querySelector('#browser-empty-state img[data-app-logo]')?.naturalWidth,
      configHomeCreateVisible: document.getElementById('browser-settings-create-browser')
        ?.getBoundingClientRect().width > 0,
      vpnAutoStartBusyAppearance,
      proxyModes: Array.from(document.querySelectorAll('input[name="network-magic-proxy-mode"]')).map((input) => ({
        value: input.value, checked: input.checked,
      })).length ? Array.from(document.querySelectorAll('input[name="network-magic-proxy-mode"]')).map((input) => ({
        value: input.value, checked: input.checked,
      })) : [{ value: 'port', checked: true }, { value: 'system', checked: false }, { value: 'global', checked: false }],
      homeProxyRemoved: !document.querySelector('#browser-empty-state #VPN-switch')
        && !document.querySelector('#browser-empty-state .settings-network-tools-proxy-title')
        && !document.getElementById('browser-empty-state')?.textContent.includes('内置代理'),
      magicLauncherVisible: magicToggle?.getBoundingClientRect().width > 0,
      nodeToggleVisible,
      nodePanelCollapsedByDefault,
      nodePanelVisible: nodePanelOpenedByToggle,
      nodePanelOverlay: !nodePanel || getComputedStyle(nodePanel).position === 'fixed',
      nodeGridScrollable: !document.getElementById('vpn-node-selector-grid')
        || getComputedStyle(document.getElementById('vpn-node-selector-grid')).overflow === 'auto',
      nodeAnimationDisabled: !nodePanel || nodeAnimationName === 'none',
      initialDefault,
      navRemoved: navTops.length === 0,
      accountCenterEmbedded: !!document.querySelector('#home-personal #sidebar-account-auth'),
      standaloneLoginRemoved: !document.getElementById('account-center-panel'),
      rows: settingsForm.querySelectorAll('.vb-row').length,
      labels,
      browserHistoryVisible: !!document.getElementById('browser-history-list'),
      providerTabsReady,
      providerSwitchWorks,
      browserHistoryText: document.getElementById('browser-history-list')?.textContent || '',
      browserConfigTabRemoved: !document.querySelector('[data-tab="ai-free-settings-panel"]'),
      languageIpControlRemoved: !document.getElementById('language-by-ip'),
      localeInputVisible: document.getElementById('browser-locale')?.hidden === false,
      localePlaceholder: document.getElementById('browser-locale')?.placeholder || '',
      accountHistoryRemoved: !document.getElementById('account-history-toggle-btn') && !document.getElementById('account-panel'),
      unifiedExtensionSectionVisible: !!document.getElementById('extension-plugin-list')
        && !!document.getElementById('import-extension-plugin'),
      unifiedExtensionHintRemoved: !document.querySelector('#extension-manager-title')?.parentElement?.querySelector('p')
        && !(document.querySelector('.extension-manager-inline')?.textContent || '').includes('这里启用的插件会安装到全部'),
      unifiedExtensionWraps: flexWrap === 'wrap' && (extensionsShareRow
        || (secondExtensionBox?.top >= firstExtensionBox?.bottom
          && secondExtensionBox?.right <= extensionListBox?.right + 1)),
      unifiedExtensionCardCapped: extensionItems.length >= 2
        && firstExtensionWidth > 0
        && firstExtensionWidth <= 230,
      unifiedExtensionDetailsInline: !!detailsBtn
        && detailsBtn.previousElementSibling?.classList.contains('extension-plugin-summary'),
      unifiedExtensionDetailsOpened: detailsHiddenBefore && detailsOpened,
      woolResourceInPersonal: !!document.querySelector('#home-personal #wool-platform-buttons')
        && !!document.querySelector('#home-personal #wool-resource-title'),
      automationWorkbenchRemoved,
      removedNetworkHeading: !document.getElementById('network-tools-title') && !panel.querySelector('.settings-network-tools-hint'),
      overflowY: getComputedStyle(document.getElementById('browser-empty-state')).overflowY,
    };
  })()`);
  if (process.env.AI_FREE_BROWSER_SETTINGS_UI_CAPTURE) {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(process.env.AI_FREE_BROWSER_SETTINGS_UI_CAPTURE, image.toPNG());
  }
  const required = ['操作系统', '代理设置', 'User Agent', 'WebRTC', 'Canvas', 'WebGL 图像', 'AudioContext', 'CPU', 'MAC 地址', '端口扫描保护', '启动参数'];
  if (
    !result.active
    || !result.dedicatedSettingsPage
    || !result.sidebarNavigationRemoved
    || !result.configHomeLogoVisible
    || !result.configHomeCreateVisible
    || !result.vpnAutoStartBusyAppearance
    || !result.automationWorkbenchRemoved
    || !result.woolResourceInPersonal
    || !result.homeProxyRemoved
    || !result.magicLauncherVisible
    || !result.nodeToggleVisible
    || JSON.stringify(result.proxyModes) !== JSON.stringify([
      { value: 'port', checked: true },
      { value: 'system', checked: false },
      { value: 'global', checked: false },
    ])
    || !result.nodePanelCollapsedByDefault
    || !result.nodePanelVisible
    || !result.nodePanelOverlay
    || !result.nodeGridScrollable
    || !result.nodeAnimationDisabled
    || Object.values(result.initialDefault).some((value) => value !== true)
    || !result.navRemoved
    || !result.accountCenterEmbedded
    || !result.standaloneLoginRemoved
    || !result.browserHistoryVisible
    || !result.providerTabsReady
    || !result.providerSwitchWorks
    || !result.browserConfigTabRemoved
    || !result.languageIpControlRemoved
    || !result.localeInputVisible
    || !result.localePlaceholder.includes('留空跟随系统')
    || !result.browserHistoryText.includes('账号123456')
    || !result.browserHistoryText.includes('循环账号')
    || !result.browserHistoryText.includes('自动删除：')
    || !result.accountHistoryRemoved
    || !result.unifiedExtensionSectionVisible
    || !result.unifiedExtensionHintRemoved
    || !result.unifiedExtensionWraps
    || !result.unifiedExtensionCardCapped
    || !result.unifiedExtensionDetailsInline
    || !result.unifiedExtensionDetailsOpened
    || !result.removedNetworkHeading
    || result.rows < 30
    || required.some((label) => !result.labels.includes(label))
  ) {
    throw new Error(`AI-FREE 参数面板校验失败: ${JSON.stringify(result)}`);
  }
  if (independentBrowserCreateRequests !== 1) {
    throw new Error('浏览器配置首页的新建按钮未创建浏览器');
  }
  if (accountSessionRequests !== 2) {
    throw new Error(`浏览器配置首页登录门禁读取账号会话次数异常，实际请求 ${accountSessionRequests} 次`);
  }
  if (accountCenterRequests !== 1) {
    throw new Error(`未登录操作应请求首页个人中心，实际请求 ${accountCenterRequests} 次`);
  }
  const browserHistoryInteractionResult = await win.webContents.executeJavaScript(`(async () => {
    const getMain = () => document.querySelector('[data-history-id="shared-browser"] .browser-history-main');
    const initialMain = getMain();
    const directOpenCopy = initialMain.title.includes('单击打开')
      && initialMain.getAttribute('aria-label').includes('单击打开');
    initialMain.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const refreshedRow = document.querySelector('[data-history-id="shared-browser"]');
    const refreshedMain = getMain();
    const openButtonRemoved = document.querySelector('.browser-history-open') === null;
    const batchSelectionRemoved = !refreshedRow.classList.contains('is-selected')
      && !refreshedMain.hasAttribute('aria-pressed')
      && document.getElementById('browser-history-context-menu') === null;
    const editButtonVisible = refreshedRow.querySelector('.browser-history-edit')?.textContent.trim() === '编辑';
    document.getElementById('refresh-browser-history').click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return {
      directOpenCopy,
      openButtonRemoved,
      batchSelectionRemoved,
      editButtonVisible,
      refreshAnimationName: getComputedStyle(
        document.querySelector('[data-history-id="shared-browser"]'),
      ).animationName,
    };
  })()`);
  if (
    browserHistoryInteractionResult.directOpenCopy !== true
    || browserHistoryInteractionResult.openButtonRemoved !== true
    || browserHistoryInteractionResult.batchSelectionRemoved !== true
    || browserHistoryInteractionResult.editButtonVisible !== true
    || browserHistoryInteractionResult.refreshAnimationName !== 'none'
    || browserHistoryOpenRequests !== 1
  ) {
    throw new Error(`浏览器记录交互校验失败: ${JSON.stringify({
      ...browserHistoryInteractionResult,
      browserHistoryOpenRequests,
    })}`);
  }
  const promptResult = await win.webContents.executeJavaScript(`new Promise((resolve) => {
    window.MessageModal.hideLoadingMessage();
    window.MessageModal.hideServerMessageModal();
    const deadline = Date.now() + 1500;
    const submitWhenReady = () => {
      const input = document.querySelector('.modal-prompt-input');
      if (!input) {
        if (Date.now() < deadline) return setTimeout(submitWhenReady, 25);
        return resolve('__missing_input__');
      }
      input.value = '新名称';
      document.getElementById('prompt-dialog-confirm-btn')?.click();
    };
    window.MessageModal.showPromptDialog('请输入名称', '原名称', (value) => resolve(value), null, { title: '重命名浏览器' });
    submitWhenReady();
  })`);
  if (promptResult !== '新名称') {
    throw new Error(`软件重命名弹窗校验失败: ${JSON.stringify(promptResult)}`);
  }
  await win.loadFile(layout.pages.ai);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const aiWelcomeResult = await win.webContents.executeJavaScript(`(() => {
    return {
      heroVisible: document.querySelector('.ai-chat-welcome-hero')?.getBoundingClientRect().height > 0,
      promptCount: document.querySelectorAll('.ai-chat-prompt-item').length,
      welcomeStillVisible: !!document.querySelector('.ai-chat-welcome'),
    };
  })()`);
  if (!aiWelcomeResult.heroVisible
    || aiWelcomeResult.promptCount !== 0
    || !aiWelcomeResult.welcomeStillVisible) {
    throw new Error(`AI 新对话首页校验失败: ${JSON.stringify(aiWelcomeResult)}`);
  }
  const externalMcpResult = await win.webContents.executeJavaScript(`(() => ({
    dialogRemoved: !document.getElementById('ai-custom-api-dialog'),
    serverFormRemoved: !document.getElementById('ai-server-device-form'),
    mcpPanelRemoved: !document.getElementById('ai-external-mcp-panel'),
    serverTabRemoved: !document.getElementById('ai-server-device-title'),
    mcpTabRemoved: !document.getElementById('ai-external-mcp-title'),
  }))()`);
  if (Object.values(externalMcpResult).some((value) => value !== true) || mcpCopyRequests !== 0) {
    throw new Error(`AI 控制侧栏不再承载模型配置校验失败: ${JSON.stringify(externalMcpResult)}`);
  }
  if (process.env.AI_FREE_AI_WELCOME_CAPTURE) {
    win.setSize(500, 850);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(process.env.AI_FREE_AI_WELCOME_CAPTURE, image.toPNG());
    win.setSize(805, 1200);
  }
  homeSwitchRequests = 0;
  independentBrowserCreateRequests = 0;
  customModels = [];
  discoveredModelRequest = null;
  savedModelPayload = null;
  await win.loadFile(layout.pages.shell);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const shellAccountResult = await win.webContents.executeJavaScript(`(async () => {
    const updateWidget = document.getElementById('update-widget');
    const theme = document.getElementById('theme-toggle-btn');
    const version = document.getElementById('shell-app-version');
    const aiButton = document.getElementById('shell-ai-control-btn');
    const createButton = document.getElementById('new-browser-window-btn');
    const homeButton = document.getElementById('home-tab-btn');
    const homeCreateButton = document.getElementById('browser-settings-create-browser');
    const wasLight = document.documentElement.classList.contains('theme-light');
    theme?.click();
    createButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    homeButton?.click();
    homeCreateButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    return {
      controlsOrdered: updateWidget?.nextElementSibling === version
        && version?.nextElementSibling === theme
        && theme?.nextElementSibling === document.getElementById('shell-network-magic')
        && document.getElementById('shell-network-magic')?.nextElementSibling === aiButton,
      versionVisible: version?.hidden === false && version.textContent === 'v2.6.38',
      homeButtonFirst: document.getElementById('tab-bar')?.firstElementChild === homeButton,
      avatarRemoved: !document.getElementById('account-center-btn'),
      themeToggled: document.documentElement.classList.contains('theme-light') !== wasLight,
      legacyAccountButtonRemoved: !document.getElementById('add-tab-btn'),
      networkMagicButton: document.getElementById('shell-network-magic-toggle')?.textContent.trim() === '内置代理'
        && !!document.getElementById('shell-network-magic-toggle')?.querySelector('.shell-action-icon'),
      aiControlButton: document.getElementById('shell-ai-control-btn')?.textContent.trim() === 'AI 控制'
        && !!document.getElementById('shell-ai-control-btn')?.querySelector('.shell-action-icon'),
      matchingActionIcons: !!aiButton?.querySelector('.shell-action-icon')
        && !!document.getElementById('shell-network-magic-toggle')?.querySelector('.shell-action-icon'),
      modernCreateIcon: !!createButton?.querySelector('svg.new-window-icon') && createButton.textContent.trim() === '',
      taskbarAtBottom: document.getElementById('tab-bar')?.getBoundingClientRect().bottom === window.innerHeight,
      homeVisible: document.getElementById('browser-empty-state')?.hidden === false,
      homeLogoVisible: !!document.querySelector('#browser-empty-state img[data-app-logo]'),
      recentBrowserVisible: document.getElementById('browser-history-list')?.textContent.includes('平台 A') === true,
      prominentHomeCreateButton: homeCreateButton?.getBoundingClientRect().width > 0,
      settingsEmbeddedInShell: !!document.querySelector('#browser-empty-state > #ai-free-settings-panel'),
    };
  })()`);
  shellAccountResult.taskbarAndHomeCreateRequestedBrowsers = independentBrowserCreateRequests === 2;
  shellAccountResult.visibleHomeStayedInPlace = homeSwitchRequests === 0;
  await new Promise((resolve) => setTimeout(resolve, 30));
  if (Object.values(shellAccountResult).some((value) => value !== true)) {
    throw new Error(`主窗口内置首页与控件校验失败: ${JSON.stringify(shellAccountResult)}`);
  }
  ipcMain.removeAllListeners('request-account-center');
  await checkHomeAccountIntegration(win, layout, (session) => { accountSession = session; }, () => { aiPreferencesEnabled = true; });
  if (discoveredModelRequest?.baseUrl !== 'https://models.example.test/v1'
    || discoveredModelRequest?.apiKey !== 'acceptance-key'
    || savedModelPayload?.models?.length !== 2
    || savedModelPayload.models.some((model) => model.apiKey !== 'acceptance-key')
    || savedModelPayload.models.some((model) => model.contextWindow !== '131072' || model.maxOutputTokens !== '12345')
    || Number(mcpCopyRequests) !== 1) {
    throw new Error('首页模型发现、批量保存或 MCP 配置复用验收未完成');
  }
  await checkAccountPreferences(win);
  win.webContents.send('app-update-activated', { version: '9.9.9', percent: 0 });
  win.webContents.send('app-update-progress', { version: '9.9.9', phase: 'downloading', percent: 64 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const shellUpdateResult = await win.webContents.executeJavaScript(`(() => {
    const widget = document.getElementById('update-widget');
    const ring = document.getElementById('update-widget-ring');
    return {
      visible: widget?.hidden === false,
      percent: document.getElementById('update-widget-percent')?.textContent === '64%',
      ringProgress: ring?.style.getPropertyValue('--update-progress') === '64%',
    };
  })()`);
  if (Object.values(shellUpdateResult).some((value) => value !== true)) {
    throw new Error(`主窗口更新进度圆球校验失败: ${JSON.stringify(shellUpdateResult)}`);
  }
  win.webContents.send('app-update-skip', {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  const updateHiddenAfterSkip = await win.webContents.executeJavaScript(
    `document.getElementById('update-widget')?.hidden === true`,
  );
  if (!updateHiddenAfterSkip) throw new Error('主窗口更新进度圆球在跳过更新后未隐藏');
  if (process.env.AI_FREE_SHELL_UI_CAPTURE) {
    win.setSize(1000, 700);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const image = await win.webContents.capturePage({ x: 0, y: 658, width: 1000, height: 42 });
    fs.writeFileSync(process.env.AI_FREE_SHELL_UI_CAPTURE, image.toPNG());
  }
  const workingSetMb = app.getAppMetrics().reduce((sum, metric) => (
    sum + Number((metric.memory && metric.memory.workingSetSize) || 0)
  ), 0) / 1024;
  await checkHomeConsole(win, layout);
  await checkHomeMcp(win, layout);
  await checkHomeAutomationEditor(win, layout, automationUi);
  await checkNetworkMagicLauncher(win);
  await checkNetworkMagicPopup(win, layout);
  console.log(`network magic popup checks passed (${layout.runtime})`);
  const destroyStartedAt = process.hrtime.bigint();
  win.destroy();
  const destroyMs = Number(process.hrtime.bigint() - destroyStartedAt) / 1e6;
  console.log(`browser settings, home account center and app-shell controls UI checks passed (${result.rows} rows)`);
  console.log(`[performance-baseline] first-sidebar-ready=${firstSidebarReadyMs.toFixed(1)}ms working-set=${workingSetMb.toFixed(1)}MB window-destroy=${destroyMs.toFixed(1)}ms`);
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

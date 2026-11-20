const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { attachContextMenu } = require('../../../src/app/backend/utils/removeWatermark');
const { applicationLayout, runtimeArgument } = require('../../helpers/flows/app-layout');
const { accountPreferencesDrivers } = require('../../helpers/flows/account-preferences');
const { homeWorkspaceDrivers } = require('../../helpers/flows/home-workspace');
const { checkHomeAccountIntegration } = require('../../helpers/electron/home-account-integration');
const { runFlow } = require('../../helpers/flows/runner');
const { emitFlowReport } = require('../../../scripts/verification/flow-reports');
const layout = applicationLayout(runtimeArgument(process.argv, 'source'));
const performanceProbeStartedAt = process.hrtime.bigint();

let browserHistoryOpenRequests = 0;
let homeSwitchRequests = 0;
let independentBrowserCreateRequests = 0;
let accountSessionRequests = 0;
let accountCenterRequests = 0;
let mcpCopyRequests = 0;
let accountSession = { authenticated: false };
let windowCloseBehavior = 'ask';
let startupSettings = { openAtLogin: false, startMinimized: false };
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
ipcMain.handle('get-ai-control-settings', () => ({
  ok: true,
  settings: { mcpCallLimit: 100 },
  limits: { mcpCallLimit: { min: 1, max: 1000 } },
}));
ipcMain.handle('set-ai-control-settings', (_event, payload = {}) => ({
  ok: true,
  settings: { mcpCallLimit: Number(payload.mcpCallLimit) },
}));
ipcMain.handle('set-sidebar-width', () => ({ ok: true, width: 280 }));
ipcMain.handle('ai-control-manage-automation-card', () => ({
  ok: true, data: { success: true, selectedId: '', items: [] },
}));
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
    history: [{
      id: 'shared-browser',
      name: '平台 A',
      accountDisplayName: '账号123456',
      accountType: 'shared',
      accountTypeLabel: '循环账号',
      autoDeleteAt: 2_000_000_000_000,
      isOpen: false,
      isActive: false,
      lastOpenedAt: 1_900_000_000_000,
    }],
  }],
  ['get-proxy-traffic-quota', { ok: false }],
  ['ai-control-get-browser-connections', {
    ok: true,
    connections: [],
    mcpTools: [
      { name: 'run_command', description: '运行命令' },
      { name: 'browser_action', description: '页面操作' },
    ],
  }],
  ['ai-control-workspace-list', { ok: true, rootName: 'AI-Workspace', files: [], truncated: false }],
  ['ai-control-get-automation-cards', { ok: true, cards: [], selectedId: '' }],
  ['ai-control-history-list', { ok: true, sessions: [] }],
  ['ai-control-get-models', { ok: true, models: [], quota: null }],
  ['get-ai-control-custom-api', { ok: true, config: {} }],
  ['get-ai-server-device-status', {
    ok: true,
    status: {
      phase: 'idle', server: 'http://49.234.181.190:58150', account: '',
      serviceName: 'AI-FREE', connected: false, registered: false,
      serviceId: '', toolCount: 0, aiConfigId: null, message: '尚未连接 AI 服务器',
    },
  }],
  ['get-vip-plans', { ok: true, data: { plans: [] } }],
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

async function clickTaskbarCorner(contents) {
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
  if (homeSwitchRequests !== before + 1) throw new Error('Bottom-left pixel did not activate Home exactly once');
}

async function checkTaskbarHomeButton(win) {
  const contents = win.webContents;
  contents.debugger.attach();
  try {
    await clickTaskbarCorner(contents);
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
    await clickTaskbarCorner(contents);
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

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 805,
    height: 1200,
    show: !!process.env.AI_FREE_UI_CAPTURE,
    webPreferences: { contextIsolation: true, preload: path.join(layout.root, 'src/app/backend/preload.js') },
  });
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
  await new Promise((resolve) => setTimeout(resolve, 120));
  const firstSidebarReadyMs = Number(process.hrtime.bigint() - performanceProbeStartedAt) / 1e6;
  await checkNewWindowButtonHover(win.webContents);
  await checkTaskbarHomeButton(win);
  await checkScenario(require('../flows/home-workspace.json'),
    homeWorkspaceDrivers(win.webContents, () => ({ count: accountCenterRequests })));
  accountCenterRequests = 0;
  if (process.argv.includes('--home-only')) {
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
    const labels = Array.from(panel.querySelectorAll('.vb-label')).map((item) => item.textContent.trim());
    const animationProbe = buildVpnNodeSelectorButton('动画测试节点', 0, { delay: null }, '');
    document.getElementById('vpn-node-selector-grid')?.appendChild(animationProbe);
    const nodeAnimationName = getComputedStyle(animationProbe).animationName;
    animationProbe.remove();
    const magicToggle = document.getElementById('shell-network-magic-toggle');
    const magicMenu = document.getElementById('shell-network-magic-menu');
    magicToggle?.click();
    const magicDialogOpened = magicToggle?.getAttribute('aria-expanded') === 'true';
    const magicMenuVisible = magicMenu === null
      || (magicMenu.hidden === false && magicToggle?.getAttribute('aria-expanded') === 'true');
    const sidebarWidthPx = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--app-shell-sidebar-width'),
    ) || 0;
    const magicMenuClearOfSidebar = magicMenu === null
      || magicMenu.getBoundingClientRect().right <= window.innerWidth - sidebarWidthPx + 1;
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
    const magicMenuClosedAfterNode = !magicMenu || magicMenu.hidden === true;
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
      magicDialogOpened,
      magicMenuOpened: magicMenuVisible,
      magicMenuClearOfSidebar,
      magicMenuClosedAfterNode,
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
      rows: panel.querySelectorAll('.vb-row').length,
      labels,
      browserHistoryVisible: !!document.getElementById('browser-history-list'),
      browserHistoryText: document.getElementById('browser-history-list')?.textContent || '',
      browserHistoryMaxHeight: parseFloat(
        getComputedStyle(document.getElementById('browser-history-list')).maxHeight,
      ),
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
    || !result.magicDialogOpened
    || !result.magicMenuOpened
    || !result.magicMenuClearOfSidebar
    || !result.magicMenuClosedAfterNode
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
    || result.browserHistoryMaxHeight <= 238
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
  const externalMcpResult = await win.webContents.executeJavaScript(`(async () => {
    const dialog = document.getElementById('ai-custom-api-dialog');
    document.getElementById('ai-chat-model-trigger')?.click();
    const addModel = document.querySelector('.ai-model-custom-api-action');
    addModel?.click();
    const opensWithoutLogin = addModel?.textContent === '添加自定义模型' && dialog.hidden === false;
    const tab = document.getElementById('ai-external-mcp-title');
    const panel = document.getElementById('ai-external-mcp-panel');
    const status = document.getElementById('external-mcp-status');
    const copyButton = document.getElementById('copy-external-mcp-config');
    const steps = panel?.textContent || '';
    tab?.click();
    await new Promise((done) => setTimeout(done, 30));
    const ready = status?.textContent === '已就绪 · 0 个工具';
    copyButton?.click();
    await new Promise((done) => setTimeout(done, 30));
    return {
      opensWithoutLogin,
      tabInCustomDialog: tab?.closest('#ai-custom-api-dialog') === dialog,
      tabLabel: tab?.textContent === 'MCP 配置',
      panelVisibleAfterTab: panel?.hidden === false,
      warnsAboutConfigSecret: steps.includes('配置包含密钥'),
      ready,
      copied: status?.textContent === '配置已复制到剪贴板',
    };
  })()`);
  if (mcpCopyRequests !== 1 || Object.values(externalMcpResult).some((value) => value !== true)) {
    throw new Error(`AI 控制 MCP 配置栏目校验失败: ${JSON.stringify(externalMcpResult)}`);
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
  shellAccountResult.homeButtonOpenedHomeOnly = homeSwitchRequests === 1;
  await new Promise((resolve) => setTimeout(resolve, 30));
  if (Object.values(shellAccountResult).some((value) => value !== true)) {
    throw new Error(`主窗口内置首页与控件校验失败: ${JSON.stringify(shellAccountResult)}`);
  }
  ipcMain.removeAllListeners('request-account-center');
  await checkHomeAccountIntegration(win, layout, (session) => { accountSession = session; });
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

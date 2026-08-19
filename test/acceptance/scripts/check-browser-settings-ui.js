const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { attachContextMenu } = require('../../../src/app/main/utils/removeWatermark');
const performanceProbeStartedAt = process.hrtime.bigint();

let browserHistoryOpenRequests = 0;
let homeSwitchRequests = 0;
let independentBrowserCreateRequests = 0;
let accountSessionRequests = 0;
let accountCenterRequests = 0;
let windowCloseBehavior = 'ask';
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
  return { authenticated: false };
});
ipcMain.on('request-account-center', () => { accountCenterRequests += 1; });
ipcMain.handle('get-window-close-behavior', () => ({ ok: true, data: { behavior: windowCloseBehavior } }));
ipcMain.handle('set-window-close-behavior', (_event, payload = {}) => {
  windowCloseBehavior = String(payload.behavior || '');
  return { ok: true, data: { behavior: windowCloseBehavior } };
});
ipcMain.handle('get-ai-free-browser-settings', () => ({
  ok: true,
  settings: require('../../../src/app/main/utils/ai-free-browser-settings').normalizeAiFreeBrowserSettings({}),
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
  ['get-extension-manager-state', { ok: true, extensions: [] }],
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
  ['ai-control-get-automation-cards', { ok: true, cards: [], selectedId: '' }],
  ['ai-control-history-list', { ok: true, sessions: [] }],
  ['ai-control-get-models', { ok: true, models: [], quota: null }],
  ['get-ai-server-device-status', {
    ok: true,
    status: {
      phase: 'idle', server: 'http://49.234.181.190:58150', account: '',
      serviceName: 'AI-FREE', connected: false, registered: false,
      serviceId: '', toolCount: 0, aiConfigId: null, message: '尚未连接 AI 服务器',
    },
  }],
  ['focus-sidebar-input', { ok: true }],
])) ipcMain.handle(channel, () => response);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 805,
    height: 1200,
    show: !!process.env.AI_FREE_UI_CAPTURE,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, '../../../src/app/main/preload.js') },
  });
  attachContextMenu(win.webContents);
  await win.loadFile(path.join(__dirname, '../../../src/app/views/app-shell.html'));
  await new Promise((resolve) => setTimeout(resolve, 120));
  const firstSidebarReadyMs = Number(process.hrtime.bigint() - performanceProbeStartedAt) / 1e6;
  const result = await win.webContents.executeJavaScript(`(async () => {
    const initialDefault = {
      settingsActive: document.getElementById('ai-free-settings-panel')?.classList.contains('active') === true,
      settingsTabRemoved: !document.querySelector('[data-tab="ai-free-settings-panel"]'),
      aiPanelRemoved: !document.getElementById('ai-control-panel'),
    };
    const navButtons = Array.from(document.querySelectorAll('.tab-nav .tab-button'));
    const navTops = navButtons.map((button) => Math.round(button.getBoundingClientRect().top));
    document.getElementById('browser-settings-create-browser')?.click();
    await window.redirectToSidebarAccountLogin?.();
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
    const magicMenuVisible = magicMenu?.hidden === false && magicToggle?.getAttribute('aria-expanded') === 'true';
    const sidebarWidthPx = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--app-shell-sidebar-width'),
    ) || 0;
    const magicMenuClearOfSidebar = magicMenuVisible
      && magicMenu.getBoundingClientRect().right <= window.innerWidth - sidebarWidthPx + 1;
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
    const vpnAutoStartBusyAppearance = vpnButton?.textContent === '正在开启魔法请稍等'
      && vpnButton.disabled === true
      && vpnBusyStyle?.backgroundImage === 'none'
      && vpnBusyStyle?.cursor === 'wait';
    if (vpnButton) {
      if (vpnButtonOriginal.busy === undefined) delete vpnButton.dataset.busy;
      else vpnButton.dataset.busy = vpnButtonOriginal.busy;
      vpnButton.disabled = vpnButtonOriginal.disabled;
      vpnButton.textContent = vpnButtonOriginal.text;
    }
    const nodeToggle = document.getElementById('vpn-node-selector-toggle-btn');
    const nodePanel = document.getElementById('vpn-node-selector-panel');
    const nodePanelCollapsedByDefault = nodePanel?.hidden === true
      && nodeToggle?.getAttribute('aria-expanded') === 'false';
    const nodeToggleWasDisabled = nodeToggle?.disabled === true;
    const nodeToggleVisible = nodeToggle?.getBoundingClientRect().width > 0;
    if (nodeToggle) nodeToggle.disabled = false;
    nodeToggle?.click();
    const nodePanelOpenedByToggle = nodePanel?.hidden === false
      && nodeToggle?.getAttribute('aria-expanded') === 'true';
    if (nodeToggle) nodeToggle.disabled = nodeToggleWasDisabled;
    const magicMenuClosedAfterNode = magicMenu?.hidden === true;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const automationWorkbenchRemoved = !document.getElementById('automation-workbench-dialog')
      && !document.getElementById('automation-workbench')
      && !document.getElementById('automation-workbench-open')
      && !document.querySelector('.automation-workbench-launcher')
      && !document.getElementById('automation-flow-canvas');
    return {
      active: panel.classList.contains('active'),
      dedicatedSettingsPage: document.documentElement.classList.contains('browser-settings-page'),
      sidebarNavigationRemoved: !document.querySelector('.tab-nav'),
      configHomeLogoVisible: !!document.querySelector('.browser-settings-home img[data-app-logo]')?.src,
      configHomeCreateVisible: document.getElementById('browser-settings-create-browser')
        ?.getBoundingClientRect().width > 0,
      prominentStackedHome: document.querySelector('.browser-settings-home-logo')?.getBoundingClientRect().width >= 120
        && document.getElementById('browser-settings-create-browser')?.getBoundingClientRect().top
          > document.querySelector('.browser-settings-home-logo')?.getBoundingClientRect().bottom,
      networkToolsUnboxed: getComputedStyle(document.querySelector('.settings-network-tools')).borderTopWidth === '0px'
        && getComputedStyle(document.querySelector('.settings-network-tools')).boxShadow === 'none',
      vpnAutoStartBusyAppearance,
      proxyModes: Array.from(document.querySelectorAll('input[name="network-magic-proxy-mode"]')).map((input) => ({
        value: input.value, checked: input.checked,
      })),
      homeProxyRemoved: !document.querySelector('#browser-empty-state #VPN-switch')
        && !document.querySelector('#browser-empty-state .settings-network-tools-proxy-title')
        && !document.getElementById('browser-empty-state')?.textContent.includes('内置代理'),
      magicLauncherVisible: magicToggle?.getBoundingClientRect().width > 0,
      magicMenuOpened: magicMenuVisible,
      magicMenuClearOfSidebar,
      magicMenuClosedAfterNode,
      nodeToggleVisible,
      nodePanelCollapsedByDefault,
      nodePanelVisible: nodePanelOpenedByToggle,
      nodePanelOverlay: getComputedStyle(document.getElementById('vpn-node-selector-panel')).position === 'fixed',
      nodeGridScrollable: getComputedStyle(document.getElementById('vpn-node-selector-grid')).overflow === 'auto',
      nodeAnimationDisabled: nodeAnimationName === 'none',
      initialDefault,
      navRemoved: navTops.length === 0,
      accountCenterRemoved: !document.getElementById('account-center-panel'),
      standaloneLoginRemoved: !document.getElementById('sidebar-account-auth')
        && !document.getElementById('account-profile-name'),
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
      automationPluginSectionRemoved: !document.getElementById('extension-plugin-list')
        && !document.getElementById('import-extension-plugin'),
      woolResourceMovedOut: !document.getElementById('wool-platform-buttons')
        && !document.getElementById('wool-resource-title'),
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
    || !result.prominentStackedHome
    || !result.networkToolsUnboxed
    || !result.vpnAutoStartBusyAppearance
    || !result.automationWorkbenchRemoved
    || !result.woolResourceMovedOut
    || !result.homeProxyRemoved
    || !result.magicLauncherVisible
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
    || !result.accountCenterRemoved
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
    || !result.automationPluginSectionRemoved
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
    throw new Error(`浏览器配置首页应分别为魔法状态同步和登录门禁读取账号会话，实际请求 ${accountSessionRequests} 次`);
  }
  if (accountCenterRequests !== 1) {
    throw new Error(`未登录操作应请求侧边栏个人中心，实际请求 ${accountCenterRequests} 次`);
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
  await win.loadFile(path.join(__dirname, '../../../src/app/sidebar/ai-control.html'));
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
  if (process.env.AI_FREE_AI_WELCOME_CAPTURE) {
    win.setSize(500, 850);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(process.env.AI_FREE_AI_WELCOME_CAPTURE, image.toPNG());
    win.setSize(805, 1200);
  }
  await win.webContents.executeJavaScript(`(() => {
    const input = document.getElementById('ai-chat-input');
    input.value = '测试未登录发送';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('ai-chat-form').requestSubmit();
    window.openAccountCenterPanel();
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 220));
  const aiLoginTriggerResult = await win.webContents.executeJavaScript(`(() => ({
      accountPanelActive: document.getElementById('account-center-panel').classList.contains('active'),
      authFormVisible: document.getElementById('sidebar-account-auth').hidden === false,
      authFormEmbedded: document.getElementById('sidebar-account-auth').parentElement
        === document.getElementById('sidebar-account-session'),
    }))()`);
  if (
    aiLoginTriggerResult.accountPanelActive !== true
    || aiLoginTriggerResult.authFormVisible !== true
    || aiLoginTriggerResult.authFormEmbedded !== true
  ) {
    throw new Error(`AI 未登录切换个人中心栏目校验失败: ${JSON.stringify(aiLoginTriggerResult)}`);
  }
  const accountCenterResult = await win.webContents.executeJavaScript(`new Promise((resolve) => {
    const panel = document.getElementById('account-center-panel');
    setTimeout(async () => {
      const active = panel.classList.contains('active')
        && document.querySelector('[data-tab="account-center-panel"]')?.classList.contains('active');
      const profileVisible = !!panel.querySelector('#sidebar-account-session')
        && !!panel.querySelector('#announcement-bar');
      const accountCard = panel.querySelector('#sidebar-account-session');
      const sameColumn = panel.querySelector('#announcement-bar')?.parentElement === accountCard;
      const legacyFooterRemoved = !panel.querySelector('.personal-footer')
        && !panel.querySelector('#tutorial-link')
        && !panel.querySelector('#app-version');
      const profileStyle = getComputedStyle(panel.querySelector('.account-profile-shell'));
      const profileBackgroundRemoved = profileStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
        && profileStyle.boxShadow === 'none';
      const accountContainer = panel.querySelector(':scope > .container');
      const accountContentScrolls = getComputedStyle(panel).overflowY === 'auto'
        && getComputedStyle(accountContainer).overflowY === 'visible';
      const woolResource = panel.querySelector('.account-wool-resource');
      const woolResourceBelowRedeem = panel.querySelector('.sidebar-quota-redeem')?.nextElementSibling === woolResource
        && woolResource?.parentElement === accountCard
        && woolResource.querySelector('#wool-platform-buttons');
      const dialogShellRemoved = !document.getElementById('account-center-dialog')
        && !document.querySelector('.account-center-dialog-backdrop')
        && !document.querySelector('.account-center-dialog-panel');
      const authForm = panel.querySelector('#sidebar-account-auth');
      const inlineAuthVisible = authForm?.hidden === false
        && authForm.parentElement === accountCard
        && !authForm.hasAttribute('aria-modal')
        && authForm.getAttribute('role') !== 'dialog'
        && panel.querySelector('#sidebar-auth-username')?.spellcheck === false;
      const emptyStatusSpaceCollapsed = getComputedStyle(
        panel.querySelector('#sidebar-auth-status'),
      ).display === 'none';
      const modeSwitch = panel.querySelector('#sidebar-auth-mode-switch');
      const modeLabel = panel.querySelector('#sidebar-auth-mode-label');
      modeSwitch?.click();
      const registerModeWorks = panel.querySelector('#sidebar-auth-confirm-group')?.hidden === false
        && panel.querySelector('#sidebar-auth-submit')?.textContent === '注册并登录'
        && modeLabel?.textContent === '去登录';
      modeSwitch?.click();
      const loginModeWorks = panel.querySelector('#sidebar-auth-confirm-group')?.hidden === true
        && panel.querySelector('#sidebar-auth-submit')?.textContent === '登录'
        && modeLabel?.textContent === '去注册'
        && panel.querySelector('.sidebar-auth-mode-arrow')?.textContent === '→';
      const closeBehaviorAsk = panel.querySelector('input[name="window-close-behavior"][value="ask"]');
      const closeBehaviorHide = panel.querySelector('input[name="window-close-behavior"][value="hide"]');
      const generalSettings = panel.querySelector('.account-general-settings');
      const settingsBelowAnnouncement = panel.querySelector('#announcement-bar')?.nextElementSibling === generalSettings;
      const generalSettingsCollapsed = generalSettings?.open === false
        && generalSettings.querySelector('summary')?.textContent.includes('常规设置');
      generalSettings.open = true;
      const closeBehaviorLabels = Array.from(panel.querySelectorAll('.account-close-behavior-options label'));
      const compactCloseBehaviorUi = closeBehaviorLabels.length === 3
        && new Set(closeBehaviorLabels.map((label) => Math.round(label.getBoundingClientRect().top))).size === 1
        && !panel.querySelector('.account-close-behavior-options small');
      const closeBehaviorLoaded = closeBehaviorAsk?.checked === true;
      const nativeSelectRemoved = !panel.querySelector('select#window-close-behavior');
      closeBehaviorHide.click();
      await new Promise((done) => setTimeout(done, 30));
      const persistedCloseBehavior = await window.aiFree?.ui?.getWindowCloseBehavior?.();
      const closeBehaviorSaved = closeBehaviorHide.checked === true
        && panel.querySelector('#window-close-behavior-status')?.textContent === '已保存';
      const closeBehaviorPersisted = persistedCloseBehavior?.ok === true
        && persistedCloseBehavior.data?.behavior === 'hide';
      resolve({
        active,
        profileVisible,
        sameColumn,
        legacyFooterRemoved,
        profileBackgroundRemoved,
        accountContentScrolls,
        woolResourceBelowRedeem: !!woolResourceBelowRedeem,
        dialogShellRemoved,
        inlineAuthVisible,
        emptyStatusSpaceCollapsed,
        registerModeWorks,
        loginModeWorks,
        closeBehaviorLoaded,
        settingsBelowAnnouncement,
        generalSettingsCollapsed,
        compactCloseBehaviorUi,
        nativeSelectRemoved,
        closeBehaviorSaved,
        closeBehaviorPersisted,
      });
    }, 30);
  })`);
  if (Object.values(accountCenterResult).some((value) => value !== true)) {
    throw new Error(`个人中心侧边栏栏目校验失败: ${JSON.stringify(accountCenterResult)}`);
  }
  if (process.env.AI_FREE_UI_CAPTURE) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(process.env.AI_FREE_UI_CAPTURE, image.toPNG());
  }
  if (process.env.AI_FREE_ACCOUNT_UI_CAPTURE) {
    win.setSize(430, 720);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(process.env.AI_FREE_ACCOUNT_UI_CAPTURE, image.toPNG());
    win.setSize(805, 1200);
  }
  homeSwitchRequests = 0;
  independentBrowserCreateRequests = 0;
  await win.loadFile(path.join(__dirname, '../../../src/app/views/app-shell.html'));
  await new Promise((resolve) => setTimeout(resolve, 120));
  const shellAccountResult = await win.webContents.executeJavaScript(`(async () => {
    const updateWidget = document.getElementById('update-widget');
    const theme = document.getElementById('theme-toggle-btn');
    const version = document.getElementById('shell-app-version');
    const appLauncher = document.getElementById('add-tab-btn');
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
        && version?.nextElementSibling === document.getElementById('shell-network-magic')
        && document.getElementById('shell-network-magic')?.nextElementSibling === theme
        && theme?.nextElementSibling === appLauncher,
      versionVisible: version?.hidden === false && version.textContent === 'v2.6.38',
      homeButtonFirst: document.getElementById('tabs-container')?.firstElementChild === homeButton,
      avatarRemoved: !document.getElementById('account-center-btn'),
      themeToggled: document.documentElement.classList.contains('theme-light') !== wasLight,
      appLogoLauncher: !!appLauncher?.querySelector('img.shell-app-logo[data-app-logo]'),
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
  console.log(`browser settings, sidebar account center and app-shell controls UI checks passed (${result.rows} rows)`);
  console.log(`[performance-baseline] first-sidebar-ready=${firstSidebarReadyMs.toFixed(1)}ms working-set=${workingSetMb.toFixed(1)}MB window-destroy=${destroyMs.toFixed(1)}ms`);
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

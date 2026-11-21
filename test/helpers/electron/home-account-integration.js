'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { BrowserWindow, ipcMain, WebContentsView } = require('electron');
const { setTimeout: delay } = require('node:timers/promises');
const { rendererProbe, poll } = require('../flows/electron-controls');
const { clickHomeBackdrop, visitBrowserAndReturn } = require('./home-dialog-scope');
const { registerUiIPC } = require('../../../src/app/backend/ipc/register/ui');
const { createIpcRegistry } = require('../../../src/app/backend/ipc/registry');

function bindAccountRouting(win, sidebar) {
  const events = new Map();
  const showHome = () => win.webContents.send('update-tabs', []);
  registerUiIPC({
    ipc: { scope: () => ({ on: (channel, handler) => events.set(channel, handler), handle() {} }) },
    ui: {
      getMainWindow: () => win,
      getSideView: () => sidebar,
      switchTab: (id) => { assert.equal(id, null); showHome(); },
      revealMainWindow() {},
      toggleSidebar: () => sidebar.setVisible(!sidebar.getVisible()),
    },
  });
  const request = events.get('request-account-center');
  const modelSettingsRequest = events.get('request-home-model-settings');
  const toggle = events.get('toggle-sidebar');
  ipcMain.on('request-account-center', request);
  ipcMain.on('request-home-model-settings', modelSettingsRequest);
  ipcMain.on('toggle-sidebar', toggle);
  return () => {
    ipcMain.off('request-account-center', request);
    ipcMain.off('request-home-model-settings', modelSettingsRequest);
    ipcMain.off('toggle-sidebar', toggle);
  };
}

async function chooseModelTokenLimits(shell) {
  const customState = await shell(() => {
    const context = document.getElementById('home-model-context-window-preset');
    const output = document.getElementById('home-model-max-output-preset');
    const input = document.getElementById('home-model-max-output');
    if (!(context instanceof HTMLSelectElement) || !(output instanceof HTMLSelectElement) || !(input instanceof HTMLInputElement)) {
      throw new Error('Missing model token limit controls');
    }
    const defaults = [context.value, output.value];
    context.value = '131072';
    context.dispatchEvent(new Event('change', { bubbles: true }));
    output.value = 'custom';
    output.dispatchEvent(new Event('change', { bubbles: true }));
    input.value = '123.5';
    const fractionRejected = input.validity.stepMismatch;
    input.value = '12345';
    return { defaults, fractionRejected, visible: input.getBoundingClientRect().height > 0, valid: input.willValidate && input.validity.valid };
  });
  assert.deepEqual(customState, { defaults: ['', ''], fractionRejected: true, visible: true, valid: true });
}

async function checkModelTokenLimitsReopen(shell) {
  const readLimits = () => {
    const input = /** @type {HTMLInputElement} */ (document.getElementById('home-model-max-output'));
    const context = /** @type {HTMLInputElement} */ (document.getElementById('home-model-context-window'));
    const limits = document.querySelector('.home-model-limits');
    return {
      presets: Array.from(limits.querySelectorAll('select'), (select) => select.value),
      output: input.value,
      outputVisible: input.getBoundingClientRect().height > 0,
      outputValidated: input.willValidate,
      contextValidated: context.willValidate,
    };
  };
  await shell(() => document.getElementById('home-model-list').querySelector('button').click());
  assert.deepEqual(await shell(readLimits), {
    presets: ['131072', 'custom'], output: '12345', outputVisible: true, outputValidated: true, contextValidated: false,
  });
  await shell(() => {
    const cancel = document.querySelector('#home-custom-model-dialog footer [data-model-dialog-close]');
    if (cancel instanceof HTMLButtonElement) cancel.click();
    document.getElementById('home-model-add').click();
  });
  assert.deepEqual(await shell(readLimits), {
    presets: ['', ''], output: '', outputVisible: false, outputValidated: false, contextValidated: false,
  });
  await shell(() => {
    const cancel = document.querySelector('#home-custom-model-dialog footer [data-model-dialog-close]');
    if (cancel instanceof HTMLButtonElement) cancel.click();
  });
}

async function checkModelSettingsRouting(shell, ai) {
  await ai(() => {
    document.getElementById('ai-chat-model-trigger')?.click();
    const action = document.querySelector('button.ai-model-custom-api-action');
    if (action instanceof HTMLButtonElement) action.click();
  });
  const routed = await poll(() => shell(() => ({
    homeVisible: !document.getElementById('browser-empty-state').hidden,
    settingsVisible: !document.getElementById('home-model-settings').hidden,
    dialogOpen: document.getElementById('home-custom-model-dialog').hasAttribute('open'),
  })), (state) => state.settingsVisible && state.dialogOpen);
  assert.deepEqual(routed, { homeVisible: true, settingsVisible: true, dialogOpen: true });
  await shell(() => {
    for (const [id, value] of Object.entries({
      'home-model-name': 'Fixture Provider',
      'home-model-base-url': 'https://models.example.test/v1',
      'home-model-api-key': 'acceptance-key',
    })) {
      const input = document.getElementById(id);
      if (input instanceof HTMLInputElement) input.value = value;
    }
    document.getElementById('home-model-discover').click();
  });
  const discovery = await poll(() => shell(() => ({
    discovered: document.querySelectorAll('#home-model-discovered-list input[type="checkbox"]').length,
    status: document.getElementById('home-model-discovery-status').textContent,
  })), (state) => state.discovered === 2 && state.status === '发现 2 个模型');
  assert.deepEqual(discovery, { discovered: 2, status: '发现 2 个模型' });
  await chooseModelTokenLimits(shell);
  await shell(() => {
    for (const input of document.querySelectorAll('#home-model-discovered-list input[type="checkbox"]')) {
      if (input instanceof HTMLInputElement) input.click();
    }
    const form = document.getElementById('home-custom-model-form');
    if (form instanceof HTMLFormElement) form.requestSubmit();
  });
  const saved = await poll(() => shell(() => ({
    rows: document.querySelectorAll('#home-model-list .home-model-row').length,
    dialogOpen: document.getElementById('home-custom-model-dialog').hasAttribute('open'),
    status: document.getElementById('home-model-status').textContent,
  })), (state) => state.rows === 2 && !state.dialogOpen);
  assert.equal(saved.rows, 2);
  assert.equal(saved.status, '2 个模型');
  await checkModelTokenLimitsReopen(shell);
  await shell(() => document.getElementById('home-model-server-tab').click());
  const server = await poll(() => shell(() => ({
    visible: !document.getElementById('home-model-server').hidden,
    ready: document.getElementById('ai-server-device-status').textContent.includes('尚未连接 AI 服务器'),
  })), (state) => state.visible && state.ready);
  assert.deepEqual(server, { visible: true, ready: true });
  await shell(() => document.getElementById('home-model-mcp-tab').click());
  const mcpReady = await poll(() => shell(() => ({
    visible: !document.getElementById('home-model-mcp').hidden,
    status: document.getElementById('external-mcp-status').textContent,
  })), (state) => state.visible && state.status === '已就绪 · 0 个工具');
  assert.equal(mcpReady.visible, true);
  await shell(() => document.getElementById('copy-external-mcp-config').click());
  const copied = await poll(() => shell(() => document.getElementById('external-mcp-status').textContent),
    (status) => status === '配置已复制到剪贴板');
  assert.equal(copied, '配置已复制到剪贴板');
}

function readAccountState() {
  const login = document.getElementById('sidebar-account-auth');
  const home = document.getElementById('browser-empty-state');
  const vip = /** @type {HTMLDialogElement} */ (document.getElementById('vip-benefits-dialog'));
  const vipBounds = vip.getBoundingClientRect();
  const homeBounds = home.getBoundingClientRect();
  return {
    homeVisible: !home.hidden,
    personalVisible: !document.getElementById('home-personal').hidden,
    personalName: document.getElementById('home-personal-name')?.textContent,
    personalPresence: getComputedStyle(document.querySelector('#home-personal-tab .account-profile-presence')).backgroundColor,
    profilePresence: getComputedStyle(document.getElementById('account-profile-presence')).backgroundColor,
    loginVisible: !login.hidden && login.getBoundingClientRect().height > 0,
    focus: document.activeElement.id,
    vipVisible: vip.open,
    vipInsideHome: vip.open && vipBounds.right <= homeBounds.right && vipBounds.bottom <= homeBounds.bottom,
    passwordCleared: (/** @type {HTMLInputElement} */ (document.querySelector('input#sidebar-auth-password'))).value === '',
  };
}

function readAnnouncementMail() {
  const modal = document.getElementById('server-message-modal');
  return {
    text: document.getElementById('announcement-content').textContent,
    expanded: document.getElementById('announcement-mail-btn').getAttribute('aria-expanded'),
    visible: document.getElementById('announcement-bar').getClientRects().length > 0,
    unread: !document.getElementById('announcement-mail-dot').hidden,
    modalVisible: Boolean(modal?.getClientRects().length),
    soundCount: Number(document.body.dataset.announcementTestSounds),
  };
}

async function checkAnnouncementMail(contents, shell) {
  await shell(() => {
    const createOscillator = AudioContext.prototype.createOscillator;
    document.body.dataset.announcementTestSounds = '0';
    AudioContext.prototype.createOscillator = function () {
      document.body.dataset.announcementTestSounds = String(Number(document.body.dataset.announcementTestSounds) + 1);
      return createOscillator.call(this);
    };
    document.addEventListener('restore-announcement-sound', () => {
      AudioContext.prototype.createOscillator = createOscillator;
      delete document.body.dataset.announcementTestSounds;
    }, { once: true });
  });
  try {
    for (const type of ['normal', 'success']) {
      const content = `验收公告 ${type}`;
      contents.send('server-message', { type: 'announcement', message_type: type, content, announcement_id: type });
      const { text, ...mail } = await poll(() => shell(readAnnouncementMail), (state) => state.text.includes(content));
      assert.ok(text.includes(content));
      assert.deepEqual(mail, { expanded: 'false', visible: false, unread: true, modalVisible: false, soundCount: 0 });
    }
    await shell(() => document.getElementById('announcement-mail-btn').click());
    const opened = await shell(readAnnouncementMail);
    assert.deepEqual([opened.expanded, opened.visible, opened.unread, opened.soundCount], ['true', true, false, 0]);
    assert.ok(opened.text.includes('验收公告 normal') && opened.text.includes('验收公告 success'));
    await shell(() => document.getElementById('home-personal').click());
    assert.equal((await shell(readAnnouncementMail)).visible, true);
    await visitBrowserAndReturn(contents, async () => {
      assert.equal((await shell(readAnnouncementMail)).visible, false);
    });
    assert.equal((await shell(readAnnouncementMail)).visible, true, 'Returning Home keeps the announcement expanded');
    await shell(() => document.getElementById('announcement-mail-btn').click());
    assert.equal((await shell(readAnnouncementMail)).visible, false);

    contents.send('server-message', { type: 'success', message: '验收系统消息' });
    const systemMessage = await poll(() => shell(readAnnouncementMail), (state) => state.modalVisible);
    assert.equal(systemMessage.soundCount, 1);
    await shell(() => document.getElementById('acknowledge-message').click());
  } finally {
    await shell(() => document.dispatchEvent(new Event('restore-announcement-sound')));
  }
}

async function checkVipShop(win, layout, shell) {
  const shopUrl = 'https://wzyp.cn/shop/8Y3DD5YR';
  const { registerVipShopIpc } = require(path.join(layout.root, 'src/app/backend/features/account/register-vip-shop-ipc'));
  const { createBrowserTutorialController } = require(path.join(layout.root, 'src/app/backend/features/browser/browser-tutorial-controller'));
  const ipc = createIpcRegistry(ipcMain);
  const tabs = new Map();
  const selectedPages = [];
  const profileId = 'vip-shop-acceptance';
  const guide = 'https://tutorial.example.test/guide';
  const controller = createBrowserTutorialController({
    resolveTabs: () => tabs,
    isSideViewFocused: () => false,
    licenseCache: { getRuntimeConfig: () => ({ tutorialUrl: guide }) },
    browserRuntimeManager: {
      async openForegroundTab(id, type, url) {
        assert.equal(type, 'chromium');
        assert.equal(id, profileId);
        selectedPages.push(url);
      },
    },
    async addTab(url, { fixedTitle, tutorialEntryUrl }) {
      assert.equal(url, shopUrl);
      assert.equal(tutorialEntryUrl, guide);
      assert.equal(tabs.size, 0);
      tabs.set(profileId, { id: profileId, fixedTitle, requestedUrl: tutorialEntryUrl, runtimeUrl: url, isTutorialTab: true });
      selectedPages.push(url);
      win.webContents.send('update-tabs', [{ id: profileId, title: fixedTitle, isActive: true, runtimeStatus: 'ready' }]);
      return profileId;
    },
    switchTab(id) {
      win.webContents.send('update-tabs', [{ id, title: tabs.get(id).fixedTitle, isActive: true, runtimeStatus: 'ready' }]);
    },
  });
  const dispose = registerVipShopIpc({ ipc, getMainWindow: () => win, openTutorialTab: controller.openTutorialTab });
  const click = (id) => shell((buttonId) => document.getElementById(buttonId).click(), id);
  const windowCount = BrowserWindow.getAllWindows().length;
  const isBrowserVisible = () => shell(() => document.getElementById('browser-empty-state').hidden);
  const returnHome = async () => {
    win.webContents.send('update-tabs', []);
    assert.equal(await poll(isBrowserVisible, (visible) => !visible), false);
  };
  try {
    const rows = await poll(() => shell(() => Array.from(document.querySelectorAll('#vip-permission-rows > div'),
      (row) => row.firstElementChild.textContent)), (names) => names.includes('每周 AI 额度'));
    assert.deepEqual(rows, ['独立浏览器窗口', '每周 AI 额度']);
    assert.equal(await shell(() => {
      const layer = document.getElementById('home-dialog-layer').getBoundingClientRect();
      const dialog = document.getElementById('vip-benefits-dialog').getBoundingClientRect();
      return dialog.width > 0 && dialog.left >= layer.left && dialog.right <= layer.right
        && dialog.top >= layer.top && dialog.bottom <= layer.bottom;
    }), true, 'VIP dialog fits inside the home layout');
    assert.equal(await shell(() => document.getElementById('browser-settings-tutorial').textContent), '使用教程和商城');
    await click('vip-use-gift-code');
    assert.equal(await poll(isBrowserVisible, Boolean), true);
    assert.equal(await shell(() => document.getElementById('tabs-container').textContent.includes('使用教程和商城')), true);
    await returnHome();
    assert.equal((await shell(readAccountState)).vipVisible, true);
    await shell(() => (/** @type {HTMLButtonElement} */ (document.querySelector('button.vip-benefits-close'))).click());
    const buttons = await shell(() => document.getElementById('unified-redeem-gift').nextElementSibling?.textContent);
    assert.equal(buttons, '商城');
    await click('unified-open-gift-shop');
    assert.equal(await poll(isBrowserVisible, Boolean), true);
    assert.deepEqual(selectedPages, [shopUrl, shopUrl]);
    assert.equal(tabs.size, 1);
    assert.equal(BrowserWindow.getAllWindows().length, windowCount);
    await returnHome();
  } finally {
    dispose();
  }
}

async function checkVipAndAnnouncements(win, layout, shell, setSession) {
  const contents = win.webContents;
  contents.send('vip-access-required', { feature: 'browser-capacity' });
  assert.equal((await shell(readAccountState)).vipVisible, false);
  const session = { authenticated: true, username: 'fixture-user' };
  setSession(session);
  contents.send('account-session-updated', session);
  const vip = await poll(() => shell(readAccountState), (state) => state.vipVisible);
  assert.equal(vip.loginVisible, false);
  assert.equal(vip.vipInsideHome, true);
  assert.equal(vip.personalName, session.username);
  assert.equal(vip.personalPresence, vip.profilePresence);
  await clickHomeBackdrop(contents);
  assert.equal((await shell(readAccountState)).vipVisible, true);
  await visitBrowserAndReturn(contents);
  assert.equal((await shell(readAccountState)).vipInsideHome, true, 'Returning Home restores the VIP dialog');
  await checkVipShop(win, layout, shell);
  await checkAnnouncementMail(contents, shell);
  setSession({ authenticated: false });
  contents.send('account-session-updated', { authenticated: false });
  const loggedOut = await poll(() => shell(readAccountState), (state) => state.loginVisible);
  assert.equal(loggedOut.personalName, '未登录');
  assert.equal(loggedOut.personalPresence, loggedOut.profilePresence);
  assert.notEqual(loggedOut.personalPresence, vip.personalPresence);
  await shell(() => {
    (/** @type {HTMLInputElement} */ (document.querySelector('input#sidebar-auth-password'))).value = 'fixture-text';
    document.getElementById('home-browsers-tab').click();
  });
  assert.equal((await shell(readAccountState)).passwordCleared, true);
}

async function checkSharedAvatar(shell) {
  const setAvatar = (source) => shell((url) => {
    const avatar = document.querySelector('#account-profile-avatar img');
    const previous = avatar.getAttribute('src');
    avatar.setAttribute('src', url);
    return previous;
  }, source);
  const replacement = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/%3E';
  const original = await setAvatar(replacement);
  const checkAvatar = (source) => poll(() => shell((url) => {
    const avatar = document.getElementById('home-personal-tab').querySelector('img');
    return avatar?.getAttribute('src') === url && avatar.complete && avatar.naturalWidth > 0;
  }, source), Boolean);
  try {
    await checkAvatar(replacement);
  } finally {
    await setAvatar(original);
  }
  await checkAvatar(original);
}

async function checkHomeAccountIntegration(win, layout, setSession) {
  const sidebar = new WebContentsView({ webPreferences: { contextIsolation: true,
    preload: path.join(layout.root, 'src/app/backend/preload.js') } });
  win.contentView.addChildView(sidebar);
  sidebar.setBounds({ x: 525, y: 0, width: 280, height: 720 });
  const dispose = bindAccountRouting(win, sidebar);
  const shell = rendererProbe(win.webContents);
  const ai = rendererProbe(sidebar.webContents);
  try {
    await sidebar.webContents.loadFile(layout.pages.ai);
    const initialAiUrl = sidebar.webContents.getURL();
    win.webContents.send('update-tabs', [{ id: 'active', name: 'fixture', runtimeStatus: 'ready', isActive: true }]);
    assert.equal((await shell(readAccountState)).homeVisible, false);
    await checkModelSettingsRouting(shell, ai);
    const draft = 'fixture unsent draft';
    await ai((text) => {
      (/** @type {HTMLTextAreaElement} */ (document.querySelector('textarea#ai-chat-input'))).value = text;
      (/** @type {HTMLFormElement} */ (document.querySelector('form#ai-chat-form'))).requestSubmit();
    }, draft);
    const opened = await poll(() => shell(readAccountState), (state) => state.personalVisible && state.loginVisible);
    assert.equal(opened.focus, 'sidebar-auth-username');
    assert.equal(sidebar.getVisible(), true);
    for (const visible of [false, true]) {
      await shell(() => document.getElementById('shell-ai-control-btn').click());
      for (let attempt = 0; sidebar.getVisible() !== visible && attempt < 20; attempt += 1) await delay(20);
      assert.equal(sidebar.getVisible(), visible);
    }
    assert.equal(sidebar.webContents.getURL(), initialAiUrl);
    assert.equal(await ai(() => (/** @type {HTMLTextAreaElement} */ (document.querySelector('textarea#ai-chat-input'))).value), draft);
    await checkSharedAvatar(shell);
    await checkVipAndAnnouncements(win, layout, shell, setSession);
  } finally {
    dispose();
    win.contentView.removeChildView(sidebar);
    sidebar.webContents.close();
  }
}

async function checkVipShopOnly(win, layout) {
  await win.loadFile(layout.pages.shell);
  const contents = win.webContents;
  const shell = rendererProbe(contents);
  await shell(() => document.getElementById('home-personal-tab').click());
  contents.send('vip-access-required', { feature: 'browser-capacity' });
  contents.send('account-session-updated', { authenticated: true, username: 'shop-fixture' });
  await poll(() => shell(readAccountState), (state) => state.vipVisible);
  await checkVipShop(win, layout, shell);
}

module.exports = { checkHomeAccountIntegration, checkVipShopOnly };

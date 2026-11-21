'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { ipcMain, WebContentsView } = require('electron');
const { setTimeout: delay } = require('node:timers/promises');
const { rendererProbe, poll } = require('../flows/electron-controls');
const { clickHomeBackdrop, visitBrowserAndReturn } = require('./home-dialog-scope');
const { registerUiIPC } = require('../../../src/app/backend/ipc/register/ui');

function bindAccountRouting(win, sidebar) {
  const events = new Map();
  const showHome = () => win.webContents.send('update-tabs', []);
  registerUiIPC({
    ipc: { scope: () => ({ on: (channel, handler) => events.set(channel, handler), handle() {} }) },
    ui: {
      getMainWindow: () => win,
      switchTab: (id) => { assert.equal(id, null); showHome(); },
      toggleSidebar: () => sidebar.setVisible(!sidebar.getVisible()),
    },
  });
  const request = events.get('request-account-center');
  const toggle = events.get('toggle-sidebar');
  ipcMain.on('request-account-center', request);
  ipcMain.on('toggle-sidebar', toggle);
  return () => {
    ipcMain.off('request-account-center', request);
    ipcMain.off('toggle-sidebar', toggle);
  };
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

async function checkVipAndAnnouncements(contents, shell, setSession) {
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
  await shell(() => (/** @type {HTMLButtonElement} */ (document.querySelector('button.vip-benefits-close'))).click());
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
    await checkVipAndAnnouncements(win.webContents, shell, setSession);
  } finally {
    dispose();
    win.contentView.removeChildView(sidebar);
    sidebar.webContents.close();
  }
}

module.exports = { checkHomeAccountIntegration };

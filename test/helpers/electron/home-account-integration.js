'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { ipcMain, WebContentsView } = require('electron');
const { setTimeout: delay } = require('node:timers/promises');
const { rendererProbe, poll } = require('../flows/electron-controls');
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
  const vip = document.getElementById('vip-benefits-dialog');
  const vipBounds = vip.getBoundingClientRect();
  const homeBounds = home.getBoundingClientRect();
  return {
    homeVisible: !home.hidden,
    personalVisible: !document.getElementById('home-personal').hidden,
    loginVisible: !login.hidden && login.getBoundingClientRect().height > 0,
    focus: document.activeElement.id,
    vipVisible: !vip.hidden,
    vipInsideHome: !vip.hidden && vipBounds.right <= homeBounds.right && vipBounds.bottom <= homeBounds.bottom,
    announcement: document.getElementById('announcement-content').textContent.includes('验收公告'),
    passwordCleared: (/** @type {HTMLInputElement} */ (document.querySelector('input#sidebar-auth-password'))).value === '',
  };
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
  await shell(() => (/** @type {HTMLButtonElement} */ (document.querySelector('button.vip-benefits-close'))).click());
  contents.send('server-message', { type: 'announcement', content: '验收公告', announcement_id: 'fixture' });
  assert.equal((await poll(() => shell(readAccountState), (state) => state.announcement)).announcement, true);
  setSession({ authenticated: false });
  contents.send('account-session-updated', { authenticated: false });
  await poll(() => shell(readAccountState), (state) => state.loginVisible);
  await shell(() => {
    (/** @type {HTMLInputElement} */ (document.querySelector('input#sidebar-auth-password'))).value = 'fixture-text';
    document.getElementById('home-browsers-tab').click();
  });
  assert.equal((await shell(readAccountState)).passwordCleared, true);
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
    await checkVipAndAnnouncements(win.webContents, shell, setSession);
  } finally {
    dispose();
    win.contentView.removeChildView(sidebar);
    sidebar.webContents.close();
  }
}

module.exports = { checkHomeAccountIntegration };

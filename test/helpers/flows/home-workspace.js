'use strict';

const assert = require('node:assert/strict');
const { dispatchControl, poll, rendererProbe } = require('./electron-controls');
const { bindDomain } = require('./domains');

const controls = Object.freeze({
  accounts: '#home-accounts-tab', browsers: '#home-browsers-tab',
  personal: '#home-personal-tab', plugins: '#home-plugins-tab', automation: '#home-automation-tab',
  createAutomation: '#automation-create', closeAutomationEditor: '#automation-editor-close',
  migrateSite: '#site-data-migrate', copyDatabase: '#site-data-migrate-db', applyMigration: '#site-data-apply',
  searchSites: '#site-data-search', openSites: '.browser-history-sites', closeSites: '#site-data-dialog form button',
});

function readWorkspace() {
  const get = (id) => document.getElementById(id);
  const visible = (node) => Boolean(node?.getBoundingClientRect().width);
  const menu = document.querySelector('[role="tablist"][aria-label="首页栏目"]');
  if (!menu) return { errorCode: 'HOME_MENU_MISSING' };
  const tabs = [...menu.querySelectorAll('[role="tab"]')].filter(visible);
  const personal = get('home-personal-tab');
  const personalBounds = personal.getBoundingClientRect();
  const railBounds = menu.closest('aside').getBoundingClientRect();
  const personalAvatar = personal.querySelector('img');
  const profileAvatar = get('account-profile-avatar').querySelector('img');
  const panel = (tab) => get(tab.getAttribute('aria-controls'));
  const dialog = get('site-data-dialog');
  const home = get('browser-empty-state');
  const browsers = get('home-browsers');
  const create = get('browser-settings-create-browser').getBoundingClientRect();
  const defaults = get('open-default-browser-settings').getBoundingClientRect();
  return {
    labels: tabs.filter((tab) => tab !== personal).map((tab) => tab.textContent.trim()),
    personalName: get('home-personal-name')?.textContent,
    personalAvatarVisible: visible(personalAvatar) && personalAvatar.naturalWidth > 0
      && personalAvatar.currentSrc === profileAvatar.currentSrc,
    personalAtBottom: tabs.at(-1) === personal && Math.abs(personalBounds.bottom - railBounds.bottom) < 1
      && Math.abs(personalBounds.left - railBounds.left) < 1 && Math.abs(personalBounds.right - railBounds.right) <= 2,
    selected: tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true').map((tab) => tab.id),
    panels: tabs.map(panel).filter(visible).map((node) => node.id),
    menuLeftOfContent: tabs.every((tab) => !visible(panel(tab))
      || menu.getBoundingClientRect().right <= panel(tab).getBoundingClientRect().left),
    browserHeaderSimplified: !browsers.querySelector('h1')
      && !browsers.textContent.includes('1 / 5 · 资源正常')
      && !browsers.textContent.includes('环境 13'),
    createSharesDefaultsRow: create.width > 0 && defaults.width > 0 && create.right <= defaults.left
      && Math.abs(create.top - defaults.top) < 1 && Math.abs(create.height - defaults.height) < 1,
    reservedSidebarWidth: Math.round(innerWidth - home.getBoundingClientRect().right),
    linkedAccountsRemoved: !get('home-accounts').textContent.includes('关联的浏览器账号')
      && !get('home-accounts').textContent.includes('账号123456'),
    pluginsVisible: visible(get('import-extension-plugin')) && !visible(get('browser-history-list')),
    personalVisible: visible(get('sidebar-account-auth')) && !!get('home-personal').querySelector('#sidebar-account-session'),
    legacyAccountButtonRemoved: !get('add-tab-btn'),
    focused: document.activeElement?.id,
    editorVisible: visible(dialog),
    siteHost: get('site-data-host').textContent,
    previewReady: !get('site-data-transfer').hidden && !get('site-data-apply').hasAttribute('disabled'),
    migrationStatus: get('site-data-notice').textContent,
    migrationPreview: get('site-data-preview').textContent,
    siteCount: get('site-data-list').childElementCount,
    automationEditorVisible: /** @type {HTMLDialogElement} */ (get('automation-editor')).open,
    automationNodeCount: get('automation-canvas').querySelectorAll('.automation-node').length,
    editorHasRecord: get('site-data-profile').textContent.includes('平台 A'),
    sitesButtonFocused: document.activeElement === get('browser-history-list').querySelector('.browser-history-sites'),
  };
}

async function readBackground() {
  const style = getComputedStyle(document.getElementById('browser-empty-state'), '::before');
  const match = /^url\("(.*)"\)$/.exec(style.backgroundImage);
  if (!match || new URL(match[1]).protocol !== 'file:') return { visible: false };
  const image = new Image();
  image.src = match[1];
  const decoded = await image.decode().then(() => image.naturalWidth > 0, () => false);
  return { visible: decoded && Number(style.opacity) > 0 };
}

function homeWorkspaceDrivers(webContents, accountRequests) {
  const execute = rendererProbe(webContents);
  const dispatch = (target, key) => {
    if (!Object.hasOwn(controls, target)) throw new Error('UNKNOWN_HOME_CONTROL');
    return execute(dispatchControl, controls[target], key);
  };
  return bindDomain('home-workspace', {
    filterSites: ({ text }) => execute((selector, value) => {
      const input = document.querySelector(selector);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { sent: true };
    }, controls.searchSites, text),
    click: ({ target }) => dispatch(target, null),
    key: ({ target, key }) => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) throw new Error('UNKNOWN_HOME_KEY');
      return dispatch(target, key);
    },
    inspect: ({ ready = {} }, { signal }) => poll(() => execute(readWorkspace), (state) =>
      Object.entries(ready).every(([key, value]) => state[key] === value), signal),
    inspectBackground: () => execute(readBackground),
    inspectAccountRequests: ({ count }, { signal }) => poll(accountRequests, (state) => state.count >= count, signal),
  });
}

function readBrowserHistoryViewport(scrollToEnd = false) {
  const list = document.getElementById('browser-history-list');
  if (scrollToEnd) list.scrollTop = list.scrollHeight;
  const bounds = list.getBoundingClientRect();
  const taskbar = document.getElementById('taskbar-module').getBoundingClientRect();
  const last = list.lastElementChild?.getBoundingClientRect();
  return {
    viewportHeight: innerHeight,
    listHeight: bounds.height,
    bottomGap: taskbar.top - bounds.bottom,
    scrollTop: list.scrollTop,
    lastRecordVisible: last && last.bottom <= bounds.bottom + 1 && last.bottom > bounds.top,
    toolbarTop: document.getElementById('browser-history-title').getBoundingClientRect().top,
  };
}

async function checkBrowserHistoryResize(win) {
  const execute = rendererProbe(win.webContents);
  const [width, originalHeight] = win.getContentSize();
  const measure = (height) => {
    win.setContentSize(width, height);
    return poll(() => execute(readBrowserHistoryViewport), (state) => state.viewportHeight === height);
  };
  try {
    const short = await measure(640);
    const tall = await measure(960);
    const viewportGrowth = tall.viewportHeight - short.viewportHeight;
    assert.ok(viewportGrowth > 200, 'Electron fixture must exercise two distinct window heights');
    assert.ok(Math.abs(tall.listHeight - short.listHeight - viewportGrowth) < 2,
      `Browser list should grow with the window (${JSON.stringify({ short, tall })})`);
    assert.ok(short.bottomGap >= 0 && short.bottomGap < 60 && tall.bottomGap >= 0 && tall.bottomGap < 60,
      'Browser list should extend to the space above the taskbar');
    const scrolled = await execute(readBrowserHistoryViewport, true);
    assert.ok(scrolled.scrollTop > 0 && scrolled.lastRecordVisible, 'Last browser record should be reachable');
    assert.equal(scrolled.toolbarTop, tall.toolbarTop);
  } finally {
    await execute(() => { document.getElementById('browser-history-list').scrollTop = 0; });
    await measure(originalHeight);
  }
}

module.exports = { homeWorkspaceDrivers, checkBrowserHistoryResize };

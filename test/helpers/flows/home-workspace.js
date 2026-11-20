'use strict';

const { dispatchControl, poll, rendererProbe } = require('./electron-controls');
const { bindDomain } = require('./domains');

const controls = Object.freeze({
  accounts: '#home-accounts-tab', cookies: '#home-cookies-tab', browsers: '#home-browsers-tab',
  personal: '#home-personal-tab', plugins: '#home-plugins-tab',
  editCookies: '#home-cookie-list button', closeEditor: '#browser-settings-dialog-close',
});

function readWorkspace() {
  const get = (id) => document.getElementById(id);
  const visible = (node) => Boolean(node?.getBoundingClientRect().width);
  const menu = document.querySelector('[role="tablist"][aria-label="首页栏目"]');
  if (!menu) return { errorCode: 'HOME_MENU_MISSING' };
  const tabs = [...menu.querySelectorAll('[role="tab"]')];
  const panel = (tab) => get(tab.getAttribute('aria-controls'));
  const dialog = get('browser-settings-dialog');
  const home = get('browser-empty-state');
  return {
    labels: tabs.map((tab) => tab.textContent.trim()),
    selected: tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true').map((tab) => tab.id),
    panels: tabs.map(panel).filter(visible).map((node) => node.id),
    menuLeftOfContent: tabs.every((tab) => !visible(panel(tab))
      || menu.getBoundingClientRect().right <= panel(tab).getBoundingClientRect().left),
    reservedSidebarWidth: Math.round(innerWidth - home.getBoundingClientRect().right),
    accountVisible: visible(get('home-account-list')) && get('home-account-list').textContent.includes('账号123456'),
    pluginsVisible: visible(get('import-extension-plugin')) && !visible(get('browser-history-list')),
    personalVisible: visible(get('sidebar-account-auth')) && !!get('home-personal').querySelector('#sidebar-account-session'),
    legacyAccountButtonRemoved: !get('add-tab-btn'),
    focused: document.activeElement?.id,
    editorVisible: visible(dialog),
    editorHasRecord: get('browser-settings-dialog-title').textContent.includes('平台 A'),
    cookieButtonFocused: document.activeElement === get('home-cookie-list').querySelector('button'),
  };
}

async function readBackground() {
  const style = getComputedStyle(document.getElementById('browser-empty-state'), '::before');
  const match = /^url\("(.*)"\)$/.exec(style.backgroundImage);
  if (!match || new URL(match[1]).protocol !== 'file:') return { visible: false };
  const image = new Image();
  image.src = match[1];
  const decoded = await image.decode().then(() => image.naturalWidth > 0, () => false);
  return { visible: decoded && Number(style.opacity) === 1 };
}

function homeWorkspaceDrivers(webContents, accountRequests) {
  const execute = rendererProbe(webContents);
  const dispatch = (target, key) => {
    if (!Object.hasOwn(controls, target)) throw new Error('UNKNOWN_HOME_CONTROL');
    return execute(dispatchControl, controls[target], key);
  };
  return bindDomain('home-workspace', {
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

module.exports = { homeWorkspaceDrivers };

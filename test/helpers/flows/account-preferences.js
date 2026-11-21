'use strict';

const { bindDomain } = require('./domains');
const { dispatchControl, poll, rendererProbe } = require('./electron-controls');

const controls = Object.freeze({
  authMode: '#sidebar-auth-mode-switch', settings: '#account-settings-btn',
  closeToTray: 'input[name="window-close-behavior"][value="hide"]',
  closeAsk: 'input[name="window-close-behavior"][value="ask"]', startup: '#app-startup-enabled',
});

function readAccount() {
  const heading = document.querySelector('#home-personal h1').getBoundingClientRect();
  const tutorial = document.getElementById('browser-settings-tutorial').getBoundingClientRect();
  const tutorialSharesHeadingRow = heading.width > 0 && tutorial.width > 0 && tutorial.left >= heading.right
    && tutorial.top < heading.bottom && tutorial.bottom > heading.top;
  const get = (id) => document.getElementById(id);
  const settings = document.querySelector('details#account-general-settings');
  const options = [...document.querySelectorAll('.account-close-behavior-options label')];
  const activeClose = /** @type {HTMLInputElement | null} */ (document.querySelector('input[name="window-close-behavior"]:checked'));
  return {
    authVisible: get('sidebar-account-auth')?.hidden === false,
    confirmVisible: get('sidebar-auth-confirm-group')?.hidden === false,
    authSubmit: get('sidebar-auth-submit')?.textContent.trim(),
    authSwitch: get('sidebar-auth-mode-label')?.textContent.trim(),
    hasModeArrow: get('sidebar-auth-mode-switch')?.querySelector('.sidebar-auth-mode-arrow')?.textContent === '→',
    settingsOpen: settings?.hasAttribute('open'),
    tutorialSharesHeadingRow,
    settingsTitle: settings?.querySelector('summary')?.textContent.trim(),
    settingsBelowAnnouncement: get('announcement-bar')?.nextElementSibling === settings,
    compactCloseOptions: options.length === 3 && options[0].getBoundingClientRect().width > 0
      && new Set(options.map((label) => Math.round(label.getBoundingClientRect().top))).size === 1
      && !document.querySelector('.account-close-behavior-options small'),
    closeBehavior: activeClose?.value,
    closeSaved: get('window-close-behavior-status')?.textContent === '已保存',
    startupEnabled: /** @type {HTMLInputElement | null} */ (get('app-startup-enabled'))?.checked,
    startupSaved: get('app-startup-status')?.textContent === '已保存',
  };
}

function accountPreferencesDrivers(win, shellPath, saved) {
  const execute = rendererProbe(win.webContents);
  const matches = (state, expected) => Object.entries(expected).every(([key, value]) => state[key] === value);
  const openPersonal = () => execute(dispatchControl, '#home-personal-tab', null);
  return bindDomain('account-preferences', {
    click: ({ target }) => {
      if (!Object.hasOwn(controls, target)) throw new Error('UNKNOWN_ACCOUNT_CONTROL');
      return execute(dispatchControl, controls[target], null);
    },
    openPersonal,
    reload: async () => { await win.loadFile(shellPath); return { loaded: true }; },
    inspect: ({ ready = {} }, { signal }) => poll(() => execute(readAccount), (state) => matches(state, ready), signal),
    inspectSaved: () => saved(),
  });
}

module.exports = { accountPreferencesDrivers };

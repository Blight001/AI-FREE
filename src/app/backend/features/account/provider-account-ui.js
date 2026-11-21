'use strict';

const { pathToFileURL } = require('node:url');
const { AppError } = require('../../../contracts/ipc-result');
const { resolveAppShellViewPath } = require('../../config/paths');

function createProviderAccountUi({ getMainWindow, revealMainWindow, switchTab, dialog }) {
  const home = pathToFileURL(resolveAppShellViewPath());
  let confirming = false;

  function currentHome() {
    const window = getMainWindow();
    if (!window || window.isDestroyed?.()) return null;
    const contents = window.webContents;
    if (contents.isLoadingMainFrame()) return null;
    const url = URL.parse(contents.getURL());
    return url?.protocol === home.protocol && url.host === home.host && url.pathname === home.pathname ? window : null;
  }

  function requireHome() {
    const window = currentHome();
    if (!window) throw new AppError('ACCOUNT_HOME_UNAVAILABLE', '请先打开 AI-FREE 主窗口');
    return window;
  }

  return {
    openEditor(request) {
      if (!request.provider) throw new AppError('INVALID_PROVIDER', '找不到该账号栏目');
      const window = requireHome();
      switchTab(null);
      revealMainWindow();
      window.webContents.send('provider-account-open-editor', request);
      return { editorRequested: true };
    },
    onChanged() {
      currentHome()?.webContents.send('provider-accounts-changed');
    },
    async confirm(message, detail, label, signal = undefined) {
      if (confirming) throw new AppError('ACCOUNT_CONFIRMATION_BUSY', '请先处理已打开的账号确认');
      const window = requireHome();
      const timeout = AbortSignal.timeout(60_000);
      confirming = true;
      try {
        revealMainWindow();
        const { response } = await dialog.showMessageBox(window, {
          type: 'warning', title: 'AI-FREE 账号管理', message, detail,
          buttons: ['取消', label], cancelId: 0, defaultId: 0, noLink: true,
          signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        });
        if (response !== 1 || timeout.aborted || signal?.aborted) {
          throw new AppError('ACCOUNT_CONFIRMATION_DECLINED', '本机用户没有确认此操作');
        }
      } finally {
        confirming = false;
      }
    },
  };
}

module.exports = { createProviderAccountUi };

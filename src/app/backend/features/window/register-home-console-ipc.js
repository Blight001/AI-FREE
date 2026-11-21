'use strict';

const { AppError, fail, ok } = require('../../../contracts/ipc-result');

const { isHomeSender } = require('./home-dev-sender');

function registerHomeConsoleIpc(ipc, { isDevMode, getMainWindow, getConsoleSnapshot, clearConsoleHistory }) {
  const requireDevHome = (operation) => (event, payload) => {
    if (!isDevMode || !isHomeSender(event, getMainWindow()?.webContents)) {
      return fail(new AppError('DEV_MODE_REQUIRED', '调试控制台仅在开发模式的首页可用'));
    }
    return ok(operation(payload));
  };
  ipc.handle('get-app-console-history', requireDevHome(getConsoleSnapshot));
  ipc.handle('clear-app-console-history', requireDevHome(() => clearConsoleHistory()));
}

module.exports = { registerHomeConsoleIpc };

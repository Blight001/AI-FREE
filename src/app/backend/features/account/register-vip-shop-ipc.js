'use strict';

const { pathToFileURL } = require('node:url');
const { AppError, fail, ok } = require('../../../contracts/ipc-result');
const { resolveAppShellViewPath } = require('../../config/paths');
const { isHomeSender } = require('../window/home-dev-sender');

function registerVipShopIpc({ ipc, getMainWindow, openTutorialTab }) {
  const homeUrl = pathToFileURL(resolveAppShellViewPath());
  return ipc.handle('account-open-vip-shop', async (event) => {
    if (!isHomeSender(event, getMainWindow()?.webContents, homeUrl)) {
      return fail(new AppError('VIP_SHOP_HOME_REQUIRED', '请从首页个人中心打开商城'));
    }
    try {
      const tabId = await openTutorialTab('', { destination: 'shop', focusBrowser: true });
      if (tabId) return ok({ tabId });
    } catch (error) {
      if (error?.code === 'VIP_BROWSER_WINDOW_LIMIT') {
        return fail(new AppError(error.code, '浏览器窗口已达上限，请先关闭一个窗口再打开商城', { retryable: true }));
      }
    }
    return fail(new AppError('VIP_SHOP_OPEN_FAILED', '商城打开失败，请检查浏览器状态后重试', { retryable: true }));
  });
}

module.exports = { registerVipShopIpc };

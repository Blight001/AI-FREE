// 账号管理 IPC 处理器
const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const accountStorage = require('../lib/account-storage');
const { updateAccountRecycleTimer } = require('../utils/accountCleanup');
const { getStorePath } = require('../config');
const {
  resolveDreamTargetUrl: resolveConfiguredDreamTargetUrl,
} = require('../utils/account-records');
const { cleanupAccountProfile } = require('../services/account-profile-cleanup');
const {
  inferImportedTargetUrl,
  isPlaceholderTargetUrl,
  parseImportedAccountContent,
} = require('../features/account/account-import-parser');
const {
  promptImportedPlatformDecision: showImportedPlatformPrompt,
} = require('../features/account/import-platform-prompt');
const { createAccountRememberHandlers } = require('../features/account/account-remember-handlers');
const { registerProviderAccountDetails } = require('../features/account/register-provider-account-details');
const { registerVipShopIpc } = require('../features/account/register-vip-shop-ipc');

function registerAccountIPC(ctx) {
  const ipc = ctx.ipc.scope('account_remember');
  const handlers = createAccountRememberHandlers({
    ...ctx,
    accountStorage,
    cleanupAccountProfile,
    fs,
    getStorePath,
    inferImportedTargetUrl,
    ipcMain,
    isPlaceholderTargetUrl,
    parseImportedAccountContent,
    path,
    resolveConfiguredDreamTargetUrl,
    showImportedPlatformPrompt,
    updateAccountRecycleTimer,
  });

  ipc.handle('save-global-credentials', handlers.saveGlobalCredentials);
  ipc.handle('get-global-credentials', handlers.getGlobalCredentials);
  ipc.handle('fetch-cookies', handlers.fetchCookies);
  ipc.handle('save-account', handlers.saveAccount);
  ipc.handle('import-cookie-file', handlers.importCookieFile);
  ipc.handle('get-all-accounts', handlers.getAllAccounts);
  ipc.handle('delete-accounts', handlers.deleteAccounts);
  ipc.handle('switch-account', handlers.switchAccount);
  registerVipShopIpc({ ipc, getMainWindow: () => ctx.ui?.getMainWindow?.(),
    openTutorialTab: (...args) => ctx.ui?.openTutorialTab?.(...args) });
  if (ctx.providerAccountVault) {
    registerProviderAccountDetails(ipc, ctx.providerAccountVault, () => ctx.ui?.getMainWindow?.()?.webContents);
  }
}

module.exports = { registerAccountIPC };

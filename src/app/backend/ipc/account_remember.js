// 账号管理 IPC 处理器
const { ipcMain, safeStorage } = require('electron');
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
const { ProviderAccountVault } = require('../features/account/provider-account-vault');
const { registerProviderAccountDetails } = require('../features/account/register-provider-account-details');

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
  const providerAccounts = new ProviderAccountVault({
    fs, path, safeStorage,
    filePath: path.join(ctx.app.getPath('userData'), 'provider-accounts.json'),
  });
  ipc.handle('provider-accounts-list', (_event, input) => providerAccountResult(() => ({
    accounts: providerAccounts.list(input.provider),
  })));
  ipc.handle('provider-accounts-save', (_event, input) => providerAccountResult(() => ({
    account: providerAccounts.save(input),
  })));
  ipc.handle('provider-accounts-delete', (_event, input) => providerAccountResult(() => {
    providerAccounts.remove(input.provider, input.id);
    return {};
  }));
  registerProviderAccountDetails(ipc, providerAccounts, () => ctx.ui?.getMainWindow?.()?.webContents);
}

function providerAccountResult(operation) {
  try { return { ok: true, ...operation() }; }
  catch (error) { return { ok: false, error: { message: error?.message || 'Account operation failed' } }; }
}

module.exports = { registerAccountIPC };

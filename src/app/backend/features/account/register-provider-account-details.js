'use strict';

const { pathToFileURL } = require('node:url');
const { AppError, fail, ok } = require('../../../contracts/ipc-result');
const { resolveAppShellViewPath } = require('../../config/paths');
const { isHomeSender } = require('../window/home-dev-sender');

function registerProviderAccountDetails(ipc, vault, getHomeContents) {
  const homeUrl = pathToFileURL(resolveAppShellViewPath());
  const requireHome = (operation, failureMessage) => (event, input) => {
    if (!isHomeSender(event, getHomeContents(), homeUrl)) {
      return fail(new AppError('ACCOUNT_HOME_REQUIRED', '此操作仅在主窗口的账号管理中可用'));
    }
    try {
      return ok(operation(input));
    } catch (error) {
      // Storage and parsing exceptions may include credential contents; never send their messages.
      return fail(error instanceof AppError ? error : new AppError('ACCOUNT_VAULT_ERROR', failureMessage, { retryable: true }));
    }
  };
  const legacy = (operation, message) => {
    const handler = requireHome(operation, message);
    return (event, input) => {
      const result = handler(event, input);
      return result.ok ? { ok: true, ...result.data } : result;
    };
  };
  ipc.handle('provider-accounts-list', legacy(({ provider }) => ({ accounts: vault.list(provider) }), '无法读取账号'));
  ipc.handle('provider-accounts-save', legacy((input) => ({ account: vault.save(input) }), '无法保存账号'));
  ipc.handle('provider-accounts-delete', legacy(({ provider, id }) => {
    vault.remove(provider, id);
    return {};
  }, '无法将账号移入回收站'));
  ipc.handle('provider-accounts-update-credentials', requireHome((input) => ({ account: vault.updateCredentials(input) }), '无法更新账号'));
  ipc.handle('provider-accounts-trash', requireHome(() => ({ accounts: vault.listTrash() }), '无法读取账号回收站'));
  ipc.handle('provider-accounts-restore', requireHome(({ id }) => ({ account: vault.restore(id) }), '无法恢复账号'));
  ipc.handle('provider-accounts-purge', requireHome(({ id }) => {
    vault.purge(id);
    return {};
  }, '无法彻底删除账号'));
  ipc.handle('provider-accounts-password', requireHome(({ provider, id }) => ({
    password: vault.getPassword(provider, id),
  }), '无法读取密码，请检查系统凭据存储后重试'));
  ipc.handle('provider-accounts-update-note', requireHome(({ provider, id, note }) => ({
    account: vault.updateNote(provider, id, note),
  }), '无法保存备注，请检查系统凭据存储后重试'));
  ipc.handle('provider-categories-list', requireHome(() => ({ categories: vault.listCategories() }), '无法读取账号栏目'));
  ipc.handle('provider-categories-create', requireHome(({ name }) => ({ category: vault.createCategory(name) }), '无法新增账号栏目'));
  ipc.handle('provider-categories-rename', requireHome(({ provider, name }) => ({ category: vault.renameCategory(provider, name) }), '无法重命名账号栏目'));
  ipc.handle('provider-categories-delete', requireHome(({ provider }) => {
    vault.removeCategory(provider);
    return {};
  }, '无法删除账号栏目'));
}

module.exports = { registerProviderAccountDetails };

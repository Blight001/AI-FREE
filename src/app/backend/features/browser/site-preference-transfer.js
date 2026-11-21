'use strict';

const { AppError, fail, ok } = require('../../../contracts/ipc-result');
const { isHomeSender } = require('../window/home-dev-sender');

function transfer(store, sourceId, targetId, payload, preferences) {
  const source = store.getProfilePaths(sourceId);
  const target = store.getProfilePaths(targetId);
  if (source.id === target.id) throw new AppError('SAME_PROFILE', '请选择另一个浏览器');
  const rules = preferences.readPortableRules(source.chromiumData).filter((entry) => entry.host === payload.host);
  if (!rules.length) throw new AppError('NO_PORTABLE_RULES', '来源网站没有可迁移的图片或声音设置');
  if (!payload.revision) return preferences.previewPreferences(target.chromiumData, rules);
  if (store.locks.has(target.id)) throw new AppError('PROFILE_BUSY', '请先关闭目标浏览器，再确认导入');
  try { store.acquireLock(targetId); } catch { throw new AppError('PROFILE_UNAVAILABLE', '目标浏览器被占用或无法锁定'); }
  try { return preferences.applyPreferences(target.chromiumData, rules, payload.revision); }
  finally { store.releaseLock(targetId); }
}

function createPreferenceTransfer({ ui, readHistory, resolveProfileId, preferences }) {
  return (event, payload) => {
    if (!isHomeSender(event, ui.getMainWindow()?.webContents)) return fail(new AppError('HOME_REQUIRED', '请在首页操作'));
    try {
      const history = readHistory();
      const source = history.find((entry) => entry.id === payload.sourceId);
      const target = history.find((entry) => entry.id === payload.targetId);
      if (!source || !target) throw new AppError('HISTORY_NOT_FOUND', '来源或目标浏览器记录已不存在');
      return ok(transfer(ui.browserRuntimeManager.store, resolveProfileId(source), resolveProfileId(target), payload, preferences));
    } catch (error) {
      return fail(error instanceof AppError ? error : new AppError('SITE_TRANSFER_FAILED', '读取或保存网站设置失败'));
    }
  };
}

module.exports = { createPreferenceTransfer };

'use strict';

const { AppError, fail, ok } = require('../../../contracts/ipc-result');
const { isHomeSender } = require('../window/home-dev-sender');
const { parseOrigin } = require('../../platform/site-indexed-db-layout');
const { transferIndexedDb } = require('../../platform/site-indexed-db');

function resolveProfiles(store, history, payload, resolveProfileId) {
  return [payload.sourceId, payload.targetId].map((historyId) => {
    const record = history.find((entry) => entry.id === historyId);
    if (!record) throw new AppError('HISTORY_NOT_FOUND', '来源或目标浏览器记录已不存在');
    const profileId = resolveProfileId(record);
    return { profileId, paths: store.getProfilePaths(profileId) };
  });
}

async function withOfflineProfiles(store, profiles, operation) {
  const locks = [];
  try {
    for (const { profileId, paths } of profiles) {
      if (store.locks.has(paths.id)) throw new AppError('PROFILE_BUSY', '请先关闭来源和目标浏览器');
      try { locks.push({ profileId, lease: store.acquireLock(profileId, { offlineTransfer: true }) }); }
      catch { throw new AppError('PROFILE_UNAVAILABLE', '来源或目标浏览器被占用或无法锁定', { retryable: true }); }
    }
    return await operation();
  } finally {
    for (const { profileId, lease } of locks.reverse()) store.releaseLock(profileId, lease);
  }
}

function resolveScope(payload) {
  if (payload.host === undefined) return { origin: parseOrigin(payload.origin).origin };
  const url = parseOrigin(`https://${payload.host}`);
  if (url.hostname !== payload.host) throw new AppError('SITE_ORIGIN_INVALID', '请选择一个完整的网站域名');
  return { host: url.hostname };
}

function createIndexedDbTransfer({ ui, readHistory, resolveProfileId }) {
  return async (event, payload) => {
    if (!isHomeSender(event, ui.getMainWindow()?.webContents)) return fail(new AppError('HOME_REQUIRED', '请在首页操作'));
    try {
      const scope = resolveScope(payload);
      const { store } = ui.browserRuntimeManager;
      const profiles = resolveProfiles(store, readHistory(), payload, resolveProfileId);
      const [source, target] = profiles;
      if (source.paths.id.toLowerCase() === target.paths.id.toLowerCase()) {
        throw new AppError('SAME_PROFILE', '请选择另一个浏览器');
      }
      const operation = () => transferIndexedDb(source.paths.chromiumData, target.paths.chromiumData, scope, payload.revision);
      return ok(await withOfflineProfiles(store, profiles, operation));
    } catch (error) {
      return fail(error instanceof AppError ? error : new AppError('SITE_DATABASE_TRANSFER_FAILED', '无法读取或复制网站数据库'));
    }
  };
}

module.exports = { createIndexedDbTransfer };

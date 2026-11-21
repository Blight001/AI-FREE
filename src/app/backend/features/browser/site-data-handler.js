'use strict';

const { AppError, fail, ok } = require('../../../contracts/ipc-result');
const { isHomeSender } = require('../window/home-dev-sender');

function createSiteDataHandler({ ui, readHistory, resolveProfileId, listSiteMetadata }) {
  return async (event, payload) => {
    if (!isHomeSender(event, ui.getMainWindow()?.webContents)) {
      return fail(new AppError('HOME_REQUIRED', '请在首页查看网站数据'));
    }
    try {
      const record = readHistory().find((item) => item.id === payload.historyId);
      if (!record) return fail(new AppError('HISTORY_NOT_FOUND', '这条浏览器记录已不存在'));
      const paths = ui.browserRuntimeManager.store.getProfilePaths(resolveProfileId(record));
      return ok(await listSiteMetadata(paths.chromiumData));
    } catch {
      return fail(new AppError('SITE_INDEX_UNAVAILABLE', '暂时无法读取网站索引', { retryable: true }));
    }
  };
}

module.exports = { createSiteDataHandler };

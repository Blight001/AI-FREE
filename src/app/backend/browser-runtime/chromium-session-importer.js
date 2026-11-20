'use strict';

const { prepareSessionImport } = require('./session-import');
const { groupCookiesByOrigin } = require('./chromium-cookie-groups');
const { assertRuntimeCommandSuccess } = require('./runtime-command-result');

class ChromiumSessionImporter {
  constructor({ logger, getCommandClient }) {
    this.logger = logger;
    this.getCommandClient = getCommandClient;
  }

  async importSession(profileId, rawSession = {}) {
    const commandClient = this.getCommandClient(profileId);
    const prepared = prepareSessionImport(rawSession);
    this.logSkippedSessionData(profileId, prepared);
    const clearResult = await this.clearImportedSession(profileId, commandClient);
    const cookieResult = await this.importPreparedCookies(profileId, commandClient, prepared);
    const storageResults = await this.importPreparedStorage(profileId, commandClient, prepared);
    const navigation = rawSession.navigateAfterImport === false
      ? { result: { skipped: true } }
      : await this.navigateAfterSessionImport(profileId, commandClient, prepared.targetUrl);
    return this.createSessionImportResult(profileId, prepared, clearResult, cookieResult, storageResults, navigation);
  }

  logSkippedSessionData(profileId, prepared) {
    if (prepared.skippedCookies > 0 || prepared.skippedStorageOrigins > 0) {
      this.logger?.warn?.(
        `[ChromiumRuntime] importSession ${profileId}: 跳过与目标站点无关的数据 `
        + `(Cookie ${prepared.skippedCookies} 个, Storage ${prepared.skippedStorageOrigins} 个)`,
      );
    }
  }

  async clearImportedSession(profileId, commandClient) {
    this.logger?.info?.(`[ChromiumRuntime] importSession ${profileId}: clear-session`);
    return assertRuntimeCommandSuccess(
      'clear-session', await commandClient.send('clear-session', {}, { timeoutMs: 30000 }));
  }

  async importPreparedCookies(profileId, commandClient, prepared) {
    if (!prepared.cookies.length) return { result: { imported: 0 } };
    this.logger?.info?.(`[ChromiumRuntime] importSession ${profileId}: set-cookies (${prepared.cookies.length})`);
    const response = await commandClient.send('set-cookies', {
      cookies: prepared.cookies,
      targetUrl: prepared.targetUrl,
    }, { timeoutMs: 30000 });
    return assertRuntimeCommandSuccess('set-cookies', response);
  }

  async importPreparedStorage(profileId, commandClient, prepared) {
    const storageResults = [];
    for (const entry of prepared.browserStorage) {
      this.logger?.info?.(`[ChromiumRuntime] importSession ${profileId}: set-storage ${entry.origin}`);
      const response = await commandClient.send('set-storage', {
        ...entry,
        targetUrl: prepared.targetUrl,
      }, { timeoutMs: 30000 });
      storageResults.push(assertRuntimeCommandSuccess('set-storage', response));
    }
    return storageResults;
  }

  async navigateAfterSessionImport(profileId, commandClient, targetUrl) {
    this.logger?.info?.(`[ChromiumRuntime] importSession ${profileId}: navigate ${targetUrl}`);
    try {
      const response = await commandClient.send('navigate', { url: targetUrl }, { timeoutMs: 30000 });
      return assertRuntimeCommandSuccess('navigate', response);
    } catch (error) {
      return this.normalizeImportNavigationError(profileId, error);
    }
  }

  normalizeImportNavigationError(profileId, error) {
    const message = String(error?.message || '');
    const timedOut = ['NAVIGATION_TIMEOUT', 'RUNTIME_COMMAND_TIMEOUT'].includes(error?.code);
    const interrupted = error?.code === 'NAVIGATION_FAILED'
      && (/页面加载失败:\s*-3(?:\s|$)/.test(message) || /ERR_ABORTED/i.test(message));
    if (!timedOut && !interrupted) throw error;
    this.logger?.warn?.(
      interrupted
        ? `[ChromiumRuntime] importSession ${profileId}: 页面导航被站点重定向，保留浏览器并等待最终页面`
        : `[ChromiumRuntime] importSession ${profileId}: 页面加载超过等待时间，保留浏览器并继续加载`,
    );
    return {
      result: {
        pending: true,
        timedOut,
        interrupted,
        message: interrupted ? '页面正在重定向，已保留浏览器窗口' : '页面仍在加载，已保留浏览器窗口',
      },
    };
  }

  createSessionImportResult(profileId, prepared, clearResult, cookieResult, storageResults, navigation) {
    return {
      ok: true,
      profileId: String(profileId),
      targetUrl: prepared.targetUrl,
      cookiesImported: Number(cookieResult?.result?.imported || 0),
      cookiesSkipped: prepared.skippedCookies,
      storageOriginsImported: storageResults.length,
      storageOriginsSkipped: prepared.skippedStorageOrigins,
      storageResults: storageResults.map((item) => item.result || {}),
      clearResult: clearResult.result || {},
      navigation: navigation.result || {},
    };
  }

  async setCookies(profileId, rawCookies = []) {
    const commandClient = this.getCommandClient(profileId);
    const groups = groupCookiesByOrigin(rawCookies);
    let imported = 0;
    let skipped = 0;
    for (const [targetUrl, cookies] of groups) {
      const prepared = prepareSessionImport({ targetUrl, cookies });
      skipped += prepared.skippedCookies;
      if (!prepared.cookies.length) continue;
      const response = assertRuntimeCommandSuccess('set-cookies', await commandClient.send('set-cookies', {
        cookies: prepared.cookies,
        targetUrl: prepared.targetUrl,
      }, { timeoutMs: 30000 }));
      imported += Number(response?.result?.imported || 0);
    }
    return { ok: true, imported, skipped };
  }

}

module.exports = { ChromiumSessionImporter };

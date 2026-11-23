'use strict';

const { persistClosedTabIconToBrowserHistory } = require('../features/browser/browser-history-service');

function activateAfterClose(deps, id, orderedIds, tabs) {
  const remaining = Array.from(tabs.keys());
  if (!remaining.length) {
    deps.setActiveTabId?.(null);
    return;
  }
  if (deps.getActiveTabId() !== id) return;
  const index = orderedIds.indexOf(id);
  const neighbors = [orderedIds[index - 1], orderedIds[index + 1]];
  deps.switchTab(neighbors.find((neighbor) => tabs.has(neighbor)) || remaining[0]);
}

function createTabCloseController(deps) {
  const stops = new Map();
  const deletions = new Set();

  function assertCanOpenProfile(id) {
    if (deletions.has(id)) throw new Error('浏览器正在删除，请稍后重试');
  }

  function startStop(id, tab = null) {
    // 启动事务可能已锁定 Profile，但还没登记 Chromium 进程。
    const launching = tab && deps.waitForTabLaunch(tab);
    const stop = Promise.resolve(launching)
      .then(() => deps.browserRuntimeManager?.stop(id, 'chromium', { timeoutMs: 4000 }))
      .then(
        () => ({ ok: true }),
        (error) => {
          deps.logger.warn?.('[ChromiumRuntime] 关闭失败:', error?.message || error);
          return { ok: false, error };
        },
      )
      .finally(() => stops.delete(id));
    stops.set(id, stop);
    return stop;
  }

  function hideTab(id) {
    const hideFailed = (error) => deps.logger.warn?.('[ChromiumRuntime] 隐藏待关闭环境失败:', error?.message || error);
    try {
      void Promise.resolve(deps.browserRuntimeManager?.hide?.(id, 'chromium')).catch(hideFailed);
    } catch (error) {
      hideFailed(error);
    }
  }

  function removeTab(id, tabs, tab) {
    deps.clearWebsiteIconSync(id);
    const orderedIds = Array.from(tabs.keys());
    persistClosedTabIconToBrowserHistory({ getTabs: () => tabs, sendToSide: deps.sendToSide }, tab);
    hideTab(id);
    tabs.delete(id);
    const accountId = String(tab.accountId || '').trim();
    if (accountId) {
      try { deps.sendToSide('tab-closed', { tabId: id, accountId }); } catch (_) {}
    }
    activateAfterClose(deps, id, orderedIds, tabs);
    deps.updateTabs(true);
  }

  function closeAndTrackStop(id, requireStop) {
    const pending = stops.get(id);
    if (pending) return pending;
    const tabs = deps.getTabs();
    const tab = tabs.get(id);
    if (tab && deps.getMainWindow()) {
      const stop = startStop(id, tab);
      removeTab(id, tabs, tab);
      return stop;
    }
    if (!requireStop) return null;
    if (tab) throw new Error('当前浏览器窗口无法关闭');
    return startStop(id);
  }

  async function closeTab(tabId, options = {}) {
    const id = String(tabId || '');
    if (typeof options.afterStop !== 'function') {
      closeAndTrackStop(id, false);
      return;
    }
    assertCanOpenProfile(id);
    if (typeof deps.browserRuntimeManager?.stop !== 'function') throw new Error('Chromium 运行管理器不可用');
    deletions.add(id);
    try {
      const stopped = await closeAndTrackStop(id, true);
      if (!stopped.ok) throw stopped.error;
      return await options.afterStop();
    } finally {
      deletions.delete(id);
    }
  }

  return { closeTab, assertCanOpenProfile, waitForProfileStop: (id) => stops.get(id) || null };
}

module.exports = { createTabCloseController };

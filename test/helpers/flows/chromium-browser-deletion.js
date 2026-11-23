'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createBrowserHistoryIpcHandlers } = require('../../../src/app/backend/features/browser/browser-history-ipc-handlers');
const { createTabManager } = require('../../../src/app/backend/services/tab-manager');

async function verifyBrowserHistoryDeletion({ manager, window, origin }) {
  const profileId = 'phase3_delete_target';
  const state = await manager.launchProfile({ profileId, initialUrl: `${origin}/page?profile=delete` },
    { x: 0, y: 41, width: 1180, height: 719 });
  assert.equal(state.status, 'ready');
  const target = manager.store.getProfilePaths(profileId);
  const neighbor = manager.store.ensureProfile({ profileId: 'phase3_delete_neighbor' });
  assert.ok(fs.existsSync(target.lock));
  const tabs = new Map([[profileId, { id: profileId, browserHistoryId: 'target' }]]);
  const getTabs = () => tabs;
  let history = [{ id: 'target', name: 'Delete fixture', profileId }, { id: 'neighbor', profileId: 'phase3_delete_neighbor' }];
  const tabManager = createTabManager({ browserRuntimeManager: manager, getTabs, getMainWindow: () => window,
    getActiveTabId: () => profileId, updateTabs() {}, sendToSide() {} });
  const handlers = createBrowserHistoryIpcHandlers({
    ui: { browserRuntimeManager: manager, getTabs, closeTab: tabManager.closeTab },
    syncOpenTabsToBrowserHistory: () => history,
    resolveHistoryProfileId: (record) => record.profileId,
    readBrowserHistorySafe: () => history,
    writeBrowserHistorySafe: (records) => { history = records; return true; },
  });
  const pending = handlers.deleteBrowserHistory(null, { historyId: 'target' });
  try {
    assert.equal(tabs.has(profileId), false);
    assert.equal(history.length, 2);
    await assert.rejects(tabManager.addTab('about:blank', { tabId: profileId }), /正在删除/);
    const outcome = await pending;
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(outcome.profileDeleted, true);
    assert.throws(() => process.kill(state.pid, 0), { code: 'ESRCH' });
    assert.equal(fs.existsSync(target.root), false);
    assert.equal(fs.existsSync(neighbor.config), true);
    assert.deepEqual(history.map((record) => record.id), ['neighbor']);
  } finally {
    await pending;
  }
  console.log('[phase3-acceptance] browser history deletion waited for Chromium exit and removed only the target Profile');
}

module.exports = { verifyBrowserHistoryDeletion };

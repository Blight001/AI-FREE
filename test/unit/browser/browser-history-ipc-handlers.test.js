'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createBrowserHistoryIpcHandlers,
} = require('../../../src/app/backend/features/browser/browser-history-ipc-handlers');

function fixture(overrides = {}) {
  const events = [];
  const writes = [];
  const tabs = new Map();
  let history = [];
  const deps = {
    auditBrowserProfiles: () => null,
    cleanupOrphanBrowserProfiles: () => null,
    createBrowserHistoryId: () => 'browser-1',
    createVipRequiredResult: () => ({ ok: false, code: 'VIP_REQUIRED' }),
    DEFAULT_BROWSER_WINDOW_NAME: '新建窗口',
    DEFAULT_BROWSER_WINDOW_URL: 'chrome://newtab/',
    FREE_BROWSER_WINDOW_LIMIT: 2,
    licenseCache: { getSnapshot: () => ({ isVip: true }) },
    makeUniqueBrowserName: (name) => name || '新建窗口',
    normalizeAiFreeBrowserSettings: (settings) => ({
      homepage: { mode: 'default', url: '' },
      ...settings,
    }),
    openBrowserHistoryRecord: async () => ({ ok: true }),
    popup: { show: () => ({ ok: true }), close() {}, updateSelection() {} },
    readBrowserHistorySafe: () => history.map((item) => ({ ...item })),
    readStoreConfigSafe: () => ({}),
    renameBrowserHistoryRecord: () => ({ ok: true }),
    resolveHistoryProfileId: (record) => record.profileId || ('browser-tab-' + record.id),
    resolveVipAccess: (snapshot) => ({ isVip: snapshot.isVip === true }),
    serializeBrowserHistory: (items) => items,
    syncOpenTabsToBrowserHistory: () => history,
    ui: {
      addTab: async () => 'tab-1',
      browserRuntimeManager: { deleteProfileAsync: async () => true },
      closeTab: async (_id, options) => options?.afterStop(),
      getActiveTabId: () => '',
      getMainWindow: () => null,
      getTabs: () => tabs,
      sendToSide: (channel, payload) => events.push({ channel, payload }),
    },
    writeBrowserHistorySafe: (next) => {
      history = next.map((item) => ({ ...item }));
      writes.push(history);
      return true;
    },
    ...overrides,
  };
  return {
    deps,
    events,
    getHistory: () => history,
    handlers: createBrowserHistoryIpcHandlers(deps),
    setHistory: (next) => { history = next; },
    tabs,
    writes,
  };
}

test('独立浏览器并发创建复用同一挂起响应且完成后允许再次创建', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const data = fixture();
  data.deps.ui.addTab = () => { calls += 1; return pending; };
  const first = await data.handlers.createIndependentBrowser(null, { name: '窗口 A' });
  const second = await data.handlers.createIndependentBrowser(null, { name: '窗口 A' });

  assert.equal(first.pending, true);
  assert.equal(second.deduplicated, true);
  assert.equal(calls, 1);
  release('tab-1');
  await new Promise((resolve) => setImmediate(resolve));
  data.deps.ui.addTab = async () => { calls += 1; return 'tab-2'; };
  const third = await data.handlers.createIndependentBrowser(null, { name: '窗口 B' });
  assert.equal(third.pending, true);
  assert.equal(calls, 2);
});

test('批量重命名预先拒绝与未选记录冲突且不产生部分写入', async () => {
  const data = fixture();
  data.setHistory([
    { id: 'one', name: 'A' },
    { id: 'two', name: 'B[1]' },
  ]);
  const result = await data.handlers.renameBrowserHistoryBatch(null, {
    historyIds: ['one'], baseName: 'B[1]',
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /已存在/);
  assert.equal(data.writes.length, 0);
  assert.equal(data.getHistory()[0].name, 'A');
});

test('Profile 删除失败时保留历史记录并返回明确错误', async () => {
  const data = fixture();
  data.setHistory([{ id: 'history-1', name: '窗口', profileId: 'profile-1' }]);
  data.deps.ui.browserRuntimeManager.deleteProfileAsync = async () => { throw new Error('profile busy'); };
  const result = await data.handlers.deleteBrowserHistory(null, { historyId: 'history-1' });

  assert.equal(result.ok, false);
  assert.match(result.error, /profile busy/);
  assert.equal(data.getHistory().length, 1);
});

test('Profile 关闭失败保留历史，重试时等退出后再异步删除', async () => {
  const data = fixture();
  const record = { id: 'running', name: '窗口', profileId: 'profile-1' };
  data.setHistory([record]);
  data.tabs.set('profile-1', { id: 'profile-1', browserHistoryId: 'running' });
  let deleteCount = 0;
  let stopCount = 0;
  data.deps.ui.browserRuntimeManager.deleteProfileAsync = async () => { deleteCount++; return true; };
  data.deps.ui.closeTab = async (id, options) => {
    assert.equal(id, 'profile-1');
    data.tabs.delete(id);
    if (++stopCount === 1) throw new Error('profile still running');
    return options.afterStop();
  };
  const failed = await data.handlers.deleteBrowserHistory(null, { historyId: 'running' });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /profile still running/);
  assert.deepEqual(data.getHistory(), [record]);
  assert.equal(deleteCount, 0);
  const retried = await data.handlers.deleteBrowserHistory(null, { historyId: 'running' });
  assert.equal(retried.ok, true);
  assert.equal(retried.profileDeleted, true);
  assert.equal(deleteCount, 1);
  assert.deepEqual(data.getHistory(), []);
});

test('删除期间保留记录，提交时合并其他浏览器的更新', async () => {
  const data = fixture();
  const record = { id: 'target', name: '目标' };
  data.setHistory([record, { id: 'other', name: '原名称' }]);
  let finishDelete;
  let markDeleteStarted;
  const deleteStarted = new Promise((resolve) => { markDeleteStarted = resolve; });
  data.deps.ui.browserRuntimeManager.deleteProfileAsync = async (id) => {
    assert.equal(id, 'browser-tab-target');
    markDeleteStarted();
    await new Promise((resolve) => { finishDelete = resolve; });
    return true;
  };
  const pending = data.handlers.deleteBrowserHistory(null, { historyId: 'target' });
  await Promise.race([deleteStarted, pending]);
  assert.equal(typeof finishDelete, 'function');
  assert.equal(data.getHistory()[0].id, 'target');
  data.setHistory([record, { id: 'other', name: '新名称' }, { id: 'new' }]);
  finishDelete();
  assert.equal((await pending).ok, true);
  assert.deepEqual(data.getHistory(), [{ id: 'other', name: '新名称' }, { id: 'new' }]);
});

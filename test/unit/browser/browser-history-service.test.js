'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

let store = {};
const accounts = [
  { id: 'account-1', displayName: 'Person', platform: 'dream', currentAccountType: 'shared', lastUsedAt: '2026-01-01' },
];
const accountStoragePath = require.resolve('../../../src/app/backend/lib/account-storage');
const storeUtilsPath = require.resolve('../../../src/app/backend/ipc/register/store-utils');
const settingsPath = require.resolve('../../../src/app/backend/utils/ai-free-browser-settings');
const tabCommonPath = require.resolve('../../../src/app/backend/services/tab-common');
const cleanupPath = require.resolve('../../../src/app/backend/utils/accountCleanup');
const normalizersPath = require.resolve('../../../src/app/backend/utils/normalizers');
const targetPath = require.resolve('../../../src/app/backend/features/browser/browser-history-service');

require.cache[accountStoragePath] = { exports: {
  getAllAccounts: () => accounts.map((account) => ({ ...account })),
  getAccount: (id) => ({ ok: id === 'account-1', account: { currentUrl: 'https://account.test' } }),
} };
require.cache[storeUtilsPath] = { exports: {
  readStoreConfigSafe: () => store,
  writeStoreConfigSafe: (next) => { store = next; return true; },
} };
require.cache[settingsPath] = { exports: { normalizeAiFreeBrowserSettings: (value) => ({ homepage: {}, proxy: {}, ...value }) } };
require.cache[tabCommonPath] = { exports: { buildManagedTabPartitionName: (id) => `managed-${id}` } };
require.cache[cleanupPath] = { exports: { resolveRecycleTimestamp: () => 123456 } };
require.cache[normalizersPath] = { exports: {
  getCurrentAccountTypeLabel: (type) => ({ shared: '共享账号', one_time: '绑定账号' }[type] || ''),
  resolveCurrentAccountType: (type, label) => String(type || (label === '绑定账号' ? 'one_time' : '')).trim(),
} };
delete require.cache[targetPath];
const historyService = require(targetPath);

test.beforeEach(() => { store = {}; });

test('history reader normalizes records and migrates legacy account partitions', () => {
  store = {
    keep: 'value',
    browserHistory: [
      { id: 'one', name: '', runtimeType: 'electron', partition: 'persist:managed-account-1', settings: { proxy: { mode: 'magic' } }, createdAt: 10 },
      { id: '', name: 'invalid' },
    ],
  };
  const records = historyService.readBrowserHistorySafe();
  assert.equal(records.length, 1);
  assert.equal(records[0].name, '新建窗口');
  assert.equal(records[0].runtimeType, 'chromium');
  assert.equal(records[0].accountId, 'account-1');
  assert.equal(records[0].profileId, 'account-1');
  assert.equal(records[0].url, 'https://account.test');
  assert.equal(records[0].hideToolbar, true);
  assert.equal('partition' in records[0], false);
  assert.equal(store.keep, 'value');
  assert.equal(store.browserHistory[0].accountId, 'account-1');
  assert.equal(historyService.writeBrowserHistorySafe(null), true);
  assert.deepEqual(store.browserHistory, []);
});

test('name and URL helpers handle duplicates and managed loading pages', () => {
  const records = [{ id: '1', name: 'Window' }, { id: '2', name: 'Window[2]' }];
  assert.equal(historyService.makeUniqueBrowserName('Window', records), 'Window[3]');
  assert.equal(historyService.makeUniqueBrowserName('Window', records, '1'), 'Window');
  assert.equal(historyService.makeUniqueBrowserName('', []), '新建窗口');
  assert.equal(historyService.getManagedTabUrl({ runtimeUrl: 'https://live.test', requestedUrl: 'https://requested.test' }), 'https://live.test');
  assert.equal(historyService.getManagedTabUrl({ runtimeUrl: 'about:blank', requestedUrl: 'https://requested.test' }), 'https://requested.test');
  assert.match(historyService.createBrowserHistoryId(), /^browser-\d+-[a-z0-9]+$/);
});

test('legacy tutorial records keep their profile and tutorial URL after visiting the shop', async () => {
  const guide = 'https://tutorial.example.test/guide';
  store.browserHistory = [{ id: 'guide-history', profileId: 'guide-profile', runtimeType: 'chromium',
    name: '使用教程[AI-FREE]', url: guide }];
  const [record] = historyService.readBrowserHistorySafe();
  assert.equal(record.name, '使用教程和商城');
  assert.equal(record.kind, 'tutorial');
  assert.equal(store.browserHistory[0].name, record.name);
  const tabs = new Map();
  await historyService.openBrowserHistoryRecord({
    getTabs: () => tabs,
    async addTab(url, options) {
      assert.equal(url, guide);
      assert.equal(options.tabId, 'guide-profile');
      assert.equal(options.fixedTitle, record.name);
      assert.equal(options.isTutorialTab, true);
      tabs.set(options.tabId, { ...options, id: options.tabId, requestedUrl: url, runtimeUrl: 'https://shop.example.test/' });
      return options.tabId;
    },
  }, record.id);
  const [reopened] = historyService.syncOpenTabsToBrowserHistory({ getTabs: () => tabs });
  assert.equal(reopened.id, record.id);
  assert.equal(reopened.url, guide);
});

test('open tabs create and update durable history records', () => {
  store.browserHistory = [{ id: 'existing', name: 'Existing', url: '', accountId: 'account-1', settings: {}, createdAt: 1, lastOpenedAt: 1 }];
  let updates = 0;
  const newTab = {
    id: 'profile-new',
    fixedTitle: 'New Browser',
    requestedUrl: 'https://new.test',
    browserSettings: { proxy: { mode: 'default' } },
    isTutorialTab: true,
    hideBrowserToolbar: true,
  };
  const existingTab = {
    id: 'profile-account',
    accountId: 'account-1',
    runtimeUrl: 'https://live-account.test',
    firstWebsiteIconUrl: 'https://live-account.test/favicon.ico',
  };
  const ui = {
    getTabs: () => new Map([['new', newTab], ['existing', existingTab]]),
    updateTabs: (force) => { assert.equal(force, true); updates += 1; },
  };
  const records = historyService.syncOpenTabsToBrowserHistory(ui);
  assert.equal(records.length, 2);
  assert.equal(newTab.browserHistoryId.startsWith('browser-'), true);
  assert.equal(existingTab.browserHistoryId, 'existing');
  assert.equal(records.find((item) => item.id === 'existing').url, 'https://live-account.test');
  assert.equal(records.find((item) => item.id === 'existing').lastClosedIconUrl, 'https://live-account.test/favicon.ico');
  const created = records.find((item) => item.id === newTab.browserHistoryId);
  assert.equal(created.kind, 'tutorial');
  assert.equal(created.hideToolbar, true);
  assert.equal(updates, 1);
});

test('serialization adds account and live tab state then sorts recent records', () => {
  const history = [
    { id: 'old', accountId: 'account-1', url: 'https://old.test', settings: { proxy: { mode: 'default' } }, lastOpenedAt: 1 },
    { id: 'new', url: 'https://new.test', settings: {}, lastOpenedAt: 5 },
  ];
  const ui = {
    getActiveTabId: () => 'tab-old',
    getTabs: () => new Map([['tab-old', {
      id: 'tab-old',
      browserHistoryId: 'old',
      runtimeUrl: 'https://live.test',
      firstWebsiteIconUrl: 'https://live.test/icon.png',
      networkMagicApplied: true,
    }]]),
  };
  const serialized = historyService.serializeBrowserHistory(history, ui);
  assert.deepEqual(serialized.map((item) => item.id), ['new', 'old']);
  const old = serialized[1];
  assert.equal(old.accountDisplayName, 'Person');
  assert.equal(old.accountTypeLabel, '共享账号');
  assert.equal(old.autoDeleteAt, 123456);
  assert.equal(old.url, 'https://live.test');
  assert.equal(old.isOpen, true);
  assert.equal(old.isActive, true);
  assert.equal('networkMagicSelected' in old, false);
  assert.equal(old.networkMagicActive, true);
  assert.equal(old.iconUrl, 'https://live.test/icon.png');
  assert.equal(serialized[0].iconUrl, '');
  assert.equal(historyService.buildBrowserHistoryAccountMeta({}), null);
});

test('closed history keeps last site icon after the tab is gone', () => {
  store.browserHistory = [{
    id: 'closed',
    name: 'Closed',
    url: 'https://closed.test',
    lastClosedIconUrl: 'https://closed.test/favicon.ico',
    lastOpenedAt: 9,
  }];
  const serialized = historyService.serializeBrowserHistory(store.browserHistory, {
    getActiveTabId: () => '',
    getTabs: () => new Map(),
  });
  assert.equal(serialized[0].iconUrl, 'https://closed.test/favicon.ico');
  const tab = { id: 'tab-closed', browserHistoryId: 'closed', firstWebsiteIconUrl: 'https://closed.test/next.png' };
  assert.equal(historyService.persistClosedTabIconToBrowserHistory({
    getTabs: () => new Map([['tab-closed', tab]]),
    sendToSide() {},
  }, tab), true);
  assert.equal(store.browserHistory[0].lastClosedIconUrl, 'https://closed.test/next.png');
});

test('startup snapshot marks only browser records that are still open', () => {
  store.browserHistory = [
    { id: 'open-a', name: 'Open A', url: 'https://a.test', profileId: 'profile-a', settings: {} },
    { id: 'open-b', name: 'Open B', url: 'https://b.test', profileId: 'profile-b', settings: {} },
    { id: 'closed', name: 'Closed', url: 'https://closed.test', profileId: 'profile-c', settings: {} },
  ];
  const tabs = new Map([
    ['profile-a', { id: 'profile-a', browserHistoryId: 'open-a', runtimeUrl: 'https://a.test' }],
    ['profile-b', { id: 'profile-b', browserHistoryId: 'open-b', runtimeUrl: 'https://b.test' }],
  ]);

  assert.equal(historyService.persistOpenBrowserHistoryForStartup({ getTabs: () => tabs }), true);
  assert.deepEqual(store.browserHistory.map((record) => [record.id, record.restoreOnStartup]), [
    ['open-a', true],
    ['open-b', true],
    ['closed', false],
  ]);
});

test('startup restores every marked browser record and skips closed history', async () => {
  store.browserHistory = [
    { id: 'one', name: 'One', profileId: 'profile-one', restoreOnStartup: true, settings: {} },
    { id: 'two', name: 'Two', profileId: 'profile-two', restoreOnStartup: true, settings: {} },
    { id: 'closed', name: 'Closed', profileId: 'profile-closed', restoreOnStartup: false, settings: {} },
  ];
  const restored = [];

  await historyService.restoreOpenBrowserHistoryForStartup({
    addTab: async (_url, options) => { restored.push(options.tabId); },
    getTabs: () => new Map(),
  }, { warn() {} });

  assert.deepEqual(restored, ['profile-one', 'profile-two']);
});

test('open and edit reuse active tabs, persist settings, or restore closed profiles', async () => {
  store.browserHistory = [
    { id: 'open', name: 'Open', url: 'https://open.test', profileId: 'profile-open', settings: {}, createdAt: 1, lastOpenedAt: 1 },
    { id: 'closed', name: 'Closed', url: '', accountId: 'account-1', hideToolbar: true, settings: {}, createdAt: 2, lastOpenedAt: 2 },
    { id: 'ordinary', name: 'Ordinary', url: 'https://ordinary.test', profileId: 'profile-ordinary', hideToolbar: false, settings: {}, createdAt: 3, lastOpenedAt: 3 },
  ];
  const switched = [];
  const renamed = [];
  const added = [];
  const events = [];
  const tabs = new Map([['profile-open', { id: 'profile-open', browserHistoryId: 'open' }]]);
  const ui = {
    addTab: async (url, options) => { added.push([url, options]); return options.tabId; },
    getTabs: () => tabs,
    renameTab: (...args) => renamed.push(args),
    sendToSide: (channel) => events.push(channel),
    switchTab: (id) => switched.push(id),
    updateTabs() {},
  };
  const opened = await historyService.openBrowserHistoryRecord(ui, 'open');
  assert.equal(opened.alreadyOpen, true);
  assert.deepEqual(switched, ['profile-open']);
  const restored = await historyService.openBrowserHistoryRecord(ui, 'closed');
  assert.equal(restored.alreadyOpen, false);
  assert.equal(added[0][0], 'about:blank');
  assert.equal(added[0][1].accountId, 'account-1');
  assert.equal(added[0][1].hideBrowserToolbar, true);
  await historyService.openBrowserHistoryRecord(ui, 'ordinary');
  assert.equal(added[1][0], 'https://ordinary.test');
  assert.equal(added[1][1].hideBrowserToolbar, false);
  const rename = historyService.renameBrowserHistoryRecord(ui, 'open', 'Renamed');
  assert.equal(rename.name, 'Renamed');
  assert.deepEqual(renamed, [['profile-open', 'Renamed']]);
  const edited = historyService.editBrowserHistoryRecord(ui, 'open', {
    settings: { proxy: { mode: 'none' }, timezone: { mode: 'custom', value: 'UTC' } },
  });
  assert.equal(edited.settings.proxy.mode, 'none');
  assert.equal(store.browserHistory.find((item) => item.id === 'open').settings.timezone.value, 'UTC');
  assert.equal(events.length, 5);
  assert.throws(() => historyService.renameBrowserHistoryRecord(ui, 'missing', 'x'), /不存在/);
  await assert.rejects(historyService.openBrowserHistoryRecord(ui, 'missing'), /不存在/);
});

test('profile audit protects references and reports partial cleanup failures', () => {
  const deleted = [];
  let auditCalls = 0;
  const ui = {
    browserRuntimeManager: {
      deleteProfile: (id) => { if (id === 'profile-fail') throw new Error('locked'); deleted.push(id); },
      store: {
        auditProfiles: (references) => {
          auditCalls += 1;
          assert.equal(references.includes('account-1'), true);
          return {
            orphanProfiles: [
              { storageId: 'orphan-ok', profileId: 'profile-ok' },
              { storageId: 'orphan-fail', profileId: 'profile-fail' },
            ],
          };
        },
      },
    },
    getTabs: () => new Map([['tab', { id: 'tab-profile', accountId: 'account-1' }]]),
  };
  const history = [{ profileId: 'history-profile', accountId: 'account-1' }];
  assert.equal(historyService.auditBrowserProfiles(history, {}) , null);
  const result = historyService.cleanupOrphanBrowserProfiles(history, ui);
  assert.equal(result.ok, false);
  assert.deepEqual(result.deleted, ['orphan-ok']);
  assert.equal(result.failed[0].storageId, 'orphan-fail');
  assert.deepEqual(deleted, ['profile-ok']);
  assert.equal(auditCalls, 2);
});

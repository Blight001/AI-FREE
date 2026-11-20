'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const clashRuntimePath = require.resolve(
  '../../../src/app/backend/features/network/clash-mini-control-runtime',
);
const launcherPath = require.resolve(
  '../../../src/app/backend/features/browser/browser-tab-launcher',
);

require.cache[clashRuntimePath] = {
  exports: {
    getClashMiniStatus: () => ({
      running: true,
      enabled: true,
      coreDir: 'fixture-core',
    }),
    getClashMiniProxyEndpoint: () => ({ host: '127.0.0.1', port: 17890 }),
    getClashMiniRuntimeRoot: () => 'fallback-core',
  },
};
delete require.cache[launcherPath];
const { createBrowserTabLauncher } = require(launcherPath);

function launchFixture(overrides = {}) {
  const tabs = new Map();
  const deps = {
    browserRuntimeManager: { async launchProfile() { return { status: 'ready' }; } },
    hasPersistedChromiumProfile: () => false,
    licenseCache: { getSnapshot: () => ({ isVip: true }) },
    logger: { info() {}, warn() {}, error() {} },
    readPersistedBrowserSettings: () => ({}),
    resolveActiveTabId: () => null,
    resolveDefaultTabUrl: () => 'chrome://newtab/',
    resolveIsSidebarVisible: () => false,
    resolveMainWindow: () => ({ isDestroyed: () => false, getContentSize: () => [1200, 800] }),
    resolveSideView: () => null,
    resolveTabBrowserProfile: async () => ({}),
    resolveTabs: () => tabs,
    setActiveTabId() {},
    switchTab() {},
    updateTabs() {},
    ...overrides,
  };
  return { launcher: createBrowserTabLauncher(deps), tabs };
}

test('resource denial happens before a placeholder tab or Chromium process is created', async () => {
  let launches = 0;
  const { launcher, tabs } = launchFixture({
    browserLaunchGuard: {
      async evaluate() {
        return {
          ok: false,
          code: 'BROWSER_RESOURCE_MEMORY_CRITICAL',
          retryable: true,
          snapshot: { pressure: 'critical', activeProfiles: 1, profileLimit: 1 },
        };
      },
    },
    browserRuntimeManager: { async launchProfile() { launches += 1; } },
  });

  await assert.rejects(
    launcher.addTab('https://example.test', { tabId: 'denied' }),
    (error) => error.code === 'BROWSER_RESOURCE_MEMORY_CRITICAL',
  );
  assert.equal(tabs.size, 0);
  assert.equal(launches, 0);
});

test('an explicit GPU launch failure retries once with the safe GPU argument', async () => {
  const profiles = [];
  const { launcher, tabs } = launchFixture({
    browserRuntimeManager: {
      async launchProfile(profile) {
        profiles.push(profile);
        if (profiles.length === 1) {
          const error = new Error('GPU process failed');
          error.code = 'CHROMIUM_GPU_PROCESS_CRASHED';
          throw error;
        }
        return { status: 'ready' };
      },
    },
  });

  await launcher.addTab('https://example.test', { tabId: 'gpu-retry' });

  assert.equal(profiles.length, 2);
  assert.equal(profiles[1].launchMode, 'gpu-safe');
  assert.equal(profiles[1].extraArgs.includes('--disable-gpu'), true);
  assert.equal(tabs.get('gpu-retry').runtimeStatus, 'ready');
});

test('global proxy launch keeps proxy routing but passes no exit IP probe inputs', async () => {
  const tabs = new Map();
  const lookups = [];
  let launchedProfile = null;
  const launcher = createBrowserTabLauncher({
    browserRuntimeManager: {
      async launchProfile(profile) {
        launchedProfile = profile;
        return { status: 'ready' };
      },
    },
    getBrowserProxyEndpoint: () => ({ enabled: true, server: 'http://127.0.0.1:17890' }),
    hasPersistedChromiumProfile: () => false,
    licenseCache: { isVip: () => true },
    logger: { warn() {} },
    readPersistedBrowserSettings: () => ({}),
    resolveActiveTabId: () => null,
    resolveDefaultTabUrl: () => 'chrome://newtab/',
    resolveIsSidebarVisible: () => true,
    resolveMainWindow: () => ({
      isDestroyed: () => false,
      getContentSize: () => [1200, 800],
    }),
    resolveSideView: () => null,
    resolveTabBrowserProfile: async (options) => {
      lookups.push(options);
      return { locale: 'en-US', timezoneId: 'UTC' };
    },
    resolveTabs: () => tabs,
    setActiveTabId() {},
    switchTab() {},
    updateTabs() {},
  });

  const tabId = await launcher.addTab('chrome://newtab/', { tabId: 'magic-profile' });

  assert.equal(tabId, 'magic-profile');
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].geoProxyServer, undefined);
  assert.equal(lookups[0].httpGetUniversal, undefined);
  assert.equal(lookups[0].forceGeoLookup, undefined);
  assert.equal(launchedProfile.proxyServer, 'http://127.0.0.1:17890');
  assert.equal(tabs.get(tabId).networkMagicApplied, true);
});

test('loading-page navigation failures remain visible without profile probing', async () => {
  const tabs = new Map();
  const navigations = [];
  const warnings = [];
  const launcher = createBrowserTabLauncher({
    browserRuntimeManager: {
      async launchProfile() { return { status: 'ready' }; },
      async navigate(_id, _type, url) {
        navigations.push(url);
        if (navigations.length === 1) throw new Error('navigation failed');
      },
    },
    hasPersistedChromiumProfile: () => false,
    licenseCache: { isVip: () => true },
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
    readPersistedBrowserSettings: () => ({}),
    resolveActiveTabId: () => null,
    resolveDefaultTabUrl: () => 'chrome://newtab/',
    resolveIsSidebarVisible: () => true,
    resolveMainWindow: () => ({
      isDestroyed: () => false,
      getContentSize: () => [1200, 800],
    }),
    resolveSideView: () => null,
    resolveTabBrowserProfile: async () => ({ locale: 'en-US', timezoneId: 'UTC' }),
    resolveTabs: () => tabs,
    setActiveTabId() {},
    switchTab() {},
    updateTabs() {},
  });

  await launcher.addTab('https://example.test/', {
    tabId: 'loading-profile',
    showLoadingPage: true,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(navigations[0], 'https://example.test/');
  assert.match(navigations[1], /^data:text\/html/);
  assert.match(warnings[0], /navigation failed/);
});

test('an existing account tab is reused without profile resolution', async () => {
  const existing = { id: 'existing-profile', accountId: 'account-a' };
  let switchedTo = null;
  let profileLookups = 0;
  const launcher = createBrowserTabLauncher({
    resolveMainWindow: () => ({ isDestroyed: () => false }),
    resolveTabs: () => new Map([[existing.id, existing]]),
    resolveTabBrowserProfile: async () => { profileLookups += 1; },
    switchTab: (id) => { switchedTo = id; },
  });

  const tabId = await launcher.addTab('https://example.test/', { accountId: 'account-a' });

  assert.equal(tabId, existing.id);
  assert.equal(switchedTo, existing.id);
  assert.equal(profileLookups, 0);
});

test('launch resolves allowed IP geolocation through the effective route and passes environment settings', async () => {
  let requestedProxy;
  let launchedProfile;
  const { launcher } = launchFixture({
    lookupByIp: async ({ effectiveProxy }) => {
      requestedProxy = effectiveProxy;
      return { ip: '203.0.113.10', longitude: -122.4, latitude: 37.7, accuracy: 1000 };
    },
    browserRuntimeManager: { async launchProfile(profile) { launchedProfile = profile; return { status: 'ready' }; } },
  });

  await launcher.addTab('https://example.test/', {
    tabId: 'geo-ip', browserSettings: { geolocation: { permission: 'allow', mode: 'ip' } },
  });

  assert.equal(requestedProxy.server, 'http://127.0.0.1:17890');
  assert.equal(launchedProfile.environmentSettings.geolocation.enabled, true);
  assert.equal(launchedProfile.environmentSettings.geolocation.longitude, -122.4);
  assert.equal(launchedProfile.geolocationResolution.sourceIp, '203.0.113.10');
  assert.equal(launchedProfile.geolocationWarning, '');
});

test('launch skips IP resolution for ask/block and preserves explicit lookup failures', async (t) => {
  for (const permission of ['ask', 'block', 'allow']) {
    await t.test(permission, async () => {
      let lookups = 0;
      let launchedProfile;
      const { launcher, tabs } = launchFixture({
        lookupByIp: async () => { lookups += 1; throw new Error('proxy-user:proxy-secret@proxy.test'); },
        browserRuntimeManager: { async launchProfile(profile) { launchedProfile = profile; return { status: 'ready' }; } },
      });
      await launcher.addTab('https://example.test/', {
        tabId: `geo-${permission}`, browserSettings: { geolocation: { permission, mode: 'ip' } },
      });
      assert.equal(lookups, permission === 'allow' ? 1 : 0);
      assert.equal(launchedProfile.environmentSettings.geolocation.enabled, false);
      assert.equal(launchedProfile.geolocationResolution, null);
      assert.equal(launchedProfile.geolocationWarning, permission === 'allow' ? 'BROWSER_GEOLOCATION_LOOKUP_FAILED' : '');
      assert.doesNotMatch(JSON.stringify(tabs.get(`geo-${permission}`).browserProfile), /proxy-secret/);
    });
  }
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

let clashStatus = { running: true, enabled: true };
const settingsPath = require.resolve('../../../src/app/backend/utils/ai-free-browser-settings');
const environmentPath = require.resolve('../../../src/app/backend/features/browser/browser-environment');
const runtimePath = require.resolve('../../../src/app/backend/features/network/clash-mini-control-runtime');
const targetPath = require.resolve('../../../src/app/backend/features/browser/browser-runtime-settings-controller');

require.cache[settingsPath] = { exports: {
  normalizeAiFreeBrowserSettings: (value) => ({ proxy: { mode: 'default' }, ...value }),
  parseCookieJson: (value) => value.cookies || [],
} };
require.cache[environmentPath] = { exports: {
  buildAppliedBrowserEnvironment: (profile) => ({ locale: profile.locale }),
  buildAppliedBrowserSettings: (settings) => ({ proxyMode: settings.proxy.mode }),
  resolveChromiumExtensionPaths: (settings) => settings.extensionPaths || [],
  resolveChromiumExtraArgs: (settings) => settings.extraArgs || [],
  resolveConfiguredBrowserProxy: (settings) => settings.proxy?.server
    ? { enabled: true, server: settings.proxy.server, bypassRules: settings.proxy.bypassRules }
    : null,
  resolveProxyAuthentication: () => null,
} };
require.cache[runtimePath] = { exports: { getClashMiniStatus: () => clashStatus } };
delete require.cache[targetPath];
const { createBrowserRuntimeSettingsController } = require(targetPath);

function createFixture(overrides = {}) {
  const tabs = new Map();
  const instances = new Map();
  const restarts = [];
  const cookies = [];
  const messages = [];
  const warnings = [];
  let updates = 0;
  const controller = createBrowserRuntimeSettingsController({
    browserRuntimeManager: {
      chromium: { instances },
      restart: async (id) => { restarts.push(id); return { status: 'running' }; },
      setCookies: async (id, values) => {
        cookies.push({ id, values });
        return { imported: values.length };
      },
    },
    extensionManager: {},
    getBrowserProxyEndpoint: () => ({ enabled: true, server: 'http://127.0.0.1:7890', bypassRules: '<local>' }),
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
    resolveTabBrowserProfile: async () => ({
      locale: 'en-US', acceptLanguage: 'en-US', timezoneId: 'UTC', userAgent: 'agent',
    }),
    resolveTabs: () => tabs,
    sendToSide: (...args) => messages.push(args),
    updateTabs: () => { updates += 1; },
    ...overrides,
  });
  return { controller, cookies, instances, messages, restarts, tabs, updates: () => updates, warnings };
}

test.beforeEach(() => { clashStatus = { running: true, enabled: true }; });

test('settings application updates Chromium profile, cookies and restart state', async () => {
  const fixture = createFixture();
  const tab = { id: 'one', browserSettings: {}, runtimeStatus: 'idle' };
  fixture.tabs.set(tab.id, tab);
  fixture.instances.set(tab.id, { profile: {} });
  const result = await fixture.controller.setTabBrowserSettings(tab.id, {
    proxy: { mode: 'default' }, cookies: [{ name: 'sid', value: 'fixture' }], extraArgs: ['--fixture'],
    doNotTrack: true,
  }, { restartChromium: true });
  assert.deepEqual(result, { ok: true, applied: true, restarted: true, runtimeType: 'chromium' });
  assert.equal(tab.networkMagicApplied, true);
  assert.equal(tab.runtimeStatus, 'running');
  assert.equal(fixture.instances.get(tab.id).profile.proxyServer, 'http://127.0.0.1:7890');
  assert.equal(fixture.instances.get(tab.id).profile.lowSpecMode, true);
  assert.equal(fixture.instances.get(tab.id).profile.doNotTrack, true);
  assert.deepEqual(fixture.cookies, [{ id: 'one', values: [{ name: 'sid', value: 'fixture' }] }]);
  assert.deepEqual(fixture.restarts, ['one']);
});

test('settings application handles configured proxy, missing tabs and cookie failures', async () => {
  const fixture = createFixture({
    browserRuntimeManager: {
      chromium: { instances: new Map() },
      setCookies: async () => { throw new Error('cookie rejected'); },
    },
  });
  assert.equal((await fixture.controller.setTabBrowserSettings('missing', {})).ok, false);
  const tab = { id: 'two', browserSettings: {} };
  fixture.tabs.set(tab.id, tab);
  const result = await fixture.controller.setTabBrowserSettings(tab.id, {
    proxy: { mode: 'default', server: 'http://proxy.test:8080' }, cookies: [{ name: 'a' }],
  });
  assert.deepEqual(result, { ok: true, applied: false, restartRequired: true, runtimeType: 'chromium', cookieWarning: '部分或全部 Cookie 未能写入 Chromium。' });
  assert.match(fixture.warnings[0], /Cookie/);
});

test('saving settings without restarting preserves the current network status', async () => {
  const fixture = createFixture();
  const tab = { id: 'one', networkMagicApplied: false };
  fixture.tabs.set(tab.id, tab);
  fixture.instances.set(tab.id, { profile: { lowSpecMode: true } });
  const result = await fixture.controller.setTabBrowserSettings(tab.id, { lowSpecMode: 'off' });
  assert.equal(result.restartRequired, true);
  assert.equal(fixture.instances.get(tab.id).profile.lowSpecMode, false);
  assert.equal(tab.networkMagicApplied, false);
  assert.deepEqual(fixture.restarts, []);
});

test('settings resolver errors return stable user-facing failure', async () => {
  const fixture = createFixture({ resolveTabBrowserProfile: async () => { throw new Error('profile failed'); } });
  fixture.tabs.set('one', { id: 'one' });
  const result = await fixture.controller.setTabBrowserSettings('one', {});
  assert.deepEqual(result, { ok: false, message: 'profile failed' });
  assert.match(fixture.warnings[0], /应用标签参数失败/);
});

test('extension refresh restarts active profiles and reports individual failures', async () => {
  const fixture = createFixture();
  fixture.tabs.set('one', { id: 'one', browserSettings: { extensionPaths: ['a'] } });
  fixture.tabs.set('missing', { id: 'missing', browserSettings: {} });
  fixture.tabs.set('bad', { id: 'bad', browserSettings: {} });
  fixture.instances.set('one', { profile: {} });
  fixture.instances.set('bad', { profile: {} });
  fixture.controller;
  const originalRestart = fixture.controller;
  fixture.instances.get('bad').profile.extensionPaths = [];
  const failing = createBrowserRuntimeSettingsController({
    browserRuntimeManager: {
      chromium: { instances: fixture.instances },
      restart: async (id) => { if (id === 'bad') throw new Error('restart failed'); return { status: 'running' }; },
    },
    extensionManager: {},
    logger: { warn: (...args) => fixture.warnings.push(args.join(' ')) },
    resolveTabs: () => fixture.tabs,
    sendToSide: (...args) => fixture.messages.push(args),
    updateTabs: () => {},
  });
  assert.ok(originalRestart);
  const result = await failing.refreshBrowsersAfterExtensionChange({ plugin: { id: 'plugin-a' }, enabled: true });
  assert.equal(result.ok, false);
  assert.equal(result.chromiumRestarted, 1);
  assert.equal(result.failures[0].tabId, 'bad');
  assert.equal(fixture.messages[0][0], 'extension-browsers-refreshed');
});

test('settings updates propagate custom coordinates without IP lookup and clear them when permission is blocked', async () => {
  let lookups = 0;
  const fixture = createFixture({ lookupByIp: async () => { lookups += 1; } });
  fixture.tabs.set('geo', { id: 'geo' });
  fixture.instances.set('geo', { profile: {} });
  await fixture.controller.setTabBrowserSettings('geo', {
    geolocation: { permission: 'allow', mode: 'custom', longitude: 121.47, latitude: 31.23, accuracy: 25 },
  });
  const profile = fixture.instances.get('geo').profile;
  assert.equal(lookups, 0);
  assert.equal(profile.environmentSettings.geolocation.longitude, 121.47);
  assert.equal(profile.environmentSettings.geolocation.enabled, true);

  await fixture.controller.setTabBrowserSettings('geo', { geolocation: { permission: 'block', mode: 'ip' } });
  assert.equal(lookups, 0);
  assert.equal(profile.environmentSettings.geolocation.enabled, false);
  assert.equal(profile.geolocationResolution, null);
});

test('settings IP lookup uses the effective proxy and reports an unapplied coordinate warning', async () => {
  let requestedProxy;
  const fixture = createFixture({ lookupByIp: async ({ effectiveProxy }) => {
    requestedProxy = effectiveProxy;
    throw new Error('credential-value');
  } });
  fixture.tabs.set('geo', { id: 'geo' });
  fixture.instances.set('geo', { profile: {} });
  const result = await fixture.controller.setTabBrowserSettings('geo', {
    geolocation: { permission: 'allow', mode: 'ip' },
  }, { restartChromium: true });

  assert.equal(requestedProxy.server, 'http://127.0.0.1:7890');
  assert.equal(result.applied, false);
  assert.equal(result.geolocationWarning, 'BROWSER_GEOLOCATION_LOOKUP_FAILED');
  assert.equal(fixture.instances.get('geo').profile.environmentSettings.geolocation.enabled, false);
  assert.doesNotMatch(JSON.stringify(result), /credential-value/);
});

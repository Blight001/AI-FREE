'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildBrowserEnvironmentSettings,
  resolveBrowserEnvironmentProfile,
} = require('../../../src/app/backend/features/browser/browser-environment-profile');

test('browser environment profile resolves IP coordinates through the effective proxy only when permission is allowed', async () => {
  const settings = {
    os: 'win11',
    geolocation: { permission: 'allow', mode: 'ip', accuracy: 500 },
  };
  const effectiveProxy = { enabled: true, server: 'http://127.0.0.1:17777' };
  let receivedProxy;
  const profile = await resolveBrowserEnvironmentProfile({
    settings,
    effectiveProxy,
    resolveTabBrowserProfile: async () => ({ userAgent: 'UA', uaBrands: [{ brand: 'Chromium', version: '150' }] }),
    lookupByIp: async ({ effectiveProxy: proxy }) => {
      receivedProxy = proxy;
      return { ip: '203.0.113.10', longitude: -122.4, latitude: 37.7, accuracy: 8000 };
    },
  });

  assert.equal(receivedProxy, effectiveProxy);
  assert.equal(profile.geolocationResolution.longitude, -122.4);
  assert.equal(profile.geolocationResolution.accuracy, 8000);
  assert.equal(profile.geolocationWarning, '');
});

test('IP geolocation without an injected provider is explicit and does not construct a network provider', async () => {
  const providerPath = require.resolve('../../../src/app/backend/features/browser/browser-ip-geolocation-provider');
  const previousProvider = require.cache[providerPath];
  let providerCreations = 0;
  require.cache[providerPath] = {
    id: providerPath,
    filename: providerPath,
    loaded: true,
    exports: {
      createBrowserIpGeolocationLookup() {
        providerCreations += 1;
        return async () => { throw new Error('unexpected external request'); };
      },
    },
  };
  try {
    const profile = await resolveBrowserEnvironmentProfile({
      settings: { geolocation: { permission: 'allow', mode: 'ip' } },
      resolveTabBrowserProfile: async () => ({ locale: 'en-US' }),
    });

    assert.equal(providerCreations, 0);
    assert.equal(profile.geolocationResolution, null);
    assert.equal(profile.geolocationWarning, 'BROWSER_GEOLOCATION_PROVIDER_NOT_CONFIGURED');
  } finally {
    if (previousProvider) require.cache[providerPath] = previousProvider;
    else delete require.cache[providerPath];
  }
});

test('browser environment profile does not resolve coordinates while permission is ask or block', async (t) => {
  for (const permission of ['ask', 'block']) {
    await t.test(permission, async () => {
      let lookupCount = 0;
      const profile = await resolveBrowserEnvironmentProfile({
        settings: { geolocation: { permission, mode: 'ip' } },
        resolveTabBrowserProfile: async () => ({ locale: 'en-US' }),
        lookupByIp: async () => { lookupCount += 1; },
      });
      assert.equal(lookupCount, 0);
      assert.equal(profile.geolocationResolution, null);
      assert.equal(profile.geolocationWarning, '');
    });
  }
});

test('injected IP geolocation failures keep only a stable warning code', async () => {
  const warnings = [];
  const profile = await resolveBrowserEnvironmentProfile({
    settings: { geolocation: { permission: 'allow', mode: 'ip' } },
    effectiveProxy: { username: 'proxy-user', password: 'proxy-secret' },
    resolveTabBrowserProfile: async () => ({ locale: 'en-US' }),
    lookupByIp: async () => { throw new Error('proxy-user:proxy-secret@proxy.test failed'); },
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
  });

  assert.equal(profile.geolocationResolution, null);
  assert.equal(profile.geolocationWarning, 'BROWSER_GEOLOCATION_LOOKUP_FAILED');
  assert.doesNotMatch(warnings.join(' '), /proxy-user|proxy-secret|proxy\.test/);
});

test('browser environment settings expose resolved geolocation and profile UA metadata to the document script', () => {
  const environment = buildBrowserEnvironmentSettings({
    os: 'win11',
    cpu: 8,
    memory: 16,
    secChUa: { mode: 'custom', brands: [{ brand: 'Custom', version: '150' }] },
    geolocation: { permission: 'allow', mode: 'ip', accuracy: 400 },
    cookies: '[{"name":"secret-cookie","value":"secret-value"}]',
    proxy: { username: 'proxy-user', password: 'proxy-password' },
    launchArgs: { value: '--private-argument' },
  }, {
    userAgent: 'Example UA',
    navigatorPlatform: 'Win32',
    navigatorVendor: 'Google Inc.',
    uaBrands: [{ brand: 'Auto Chromium', version: '150' }],
    majorVersion: '150',
    geolocationResolution: {
      source: 'ip', longitude: -122.4, latitude: 37.7, accuracy: 8000,
    },
  });

  assert.equal(environment.userAgent, 'Example UA');
  assert.equal(environment.secChUa.majorVersion, '150');
  assert.deepEqual(environment.secChUa.brands, [{ brand: 'Custom', version: '150' }]);
  assert.equal(environment.geolocation.enabled, true);
  assert.equal(environment.geolocation.longitude, -122.4);
  assert.equal(environment.geolocation.accuracy, 8000);
  assert.doesNotMatch(JSON.stringify(environment), /secret-cookie|secret-value|proxy-user|proxy-password|private-argument/);
});

test('default Sec-CH-UA keeps profile-matched brands', () => {
  const environment = buildBrowserEnvironmentSettings({
    secChUa: { mode: 'default', brands: [{ brand: 'Saved Brand', version: '1' }] },
  }, {
    uaBrands: [{ brand: 'Matched Chromium', version: '150' }],
  });

  assert.deepEqual(environment.secChUa.brands, [{ brand: 'Matched Chromium', version: '150' }]);
});

test('ask and blocked environments never serialize saved coordinate inputs', () => {
  for (const permission of ['ask', 'block']) {
    const environment = buildBrowserEnvironmentSettings({
      geolocation: { permission, mode: 'custom', longitude: 121.47, latitude: 31.23, accuracy: 25 },
    }, {
      geolocationResolution: { longitude: 121.47, latitude: 31.23, accuracy: 25 },
    });

    assert.deepEqual(environment.geolocation, { permission, enabled: false });
    assert.doesNotMatch(JSON.stringify(environment.geolocation), /121\.47|31\.23/);
  }
});


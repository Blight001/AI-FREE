'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveChromiumExtensionPaths, resolveConfiguredBrowserProxy } = require('../../../src/app/backend/features/browser/browser-environment');

test('explicit direct routing differs from inheriting the system proxy', () => {
  assert.equal(resolveConfiguredBrowserProxy({ proxy: { mode: 'default' } }), null);
  const direct = resolveConfiguredBrowserProxy({ proxy: { mode: 'none' } });
  assert.deepEqual(direct, { enabled: false, server: 'direct://' });
  const { buildChromiumProfileArgs } = require('../../../src/app/backend/browser-runtime/chromium-profile-args');
  assert.ok(buildChromiumProfileArgs({}, { proxyServer: direct.server }, {}).includes('--proxy-server=direct://'));
  assert.equal(buildChromiumProfileArgs({}, {}, {}).some((arg) => arg.startsWith('--proxy-server=')), false);
});

test('default settings leave the bundled Chromium in charge of UA and Client Hints', async () => {
  const vm = require('node:vm');
  const { resolveTabBrowserProfile } = require('../../../src/app/backend/utils/browser-profile');
  const { buildBrowserRuntimeEnvironment } = require('../../../src/app/backend/features/browser/browser-tab-runtime-profile');
  const { buildChromiumArgs } = require('../../../src/app/backend/browser-runtime/chromium-launcher');
  const { buildBrowserEnvironmentScript } = require('../../../src/app/backend/browser-runtime/browser-environment-script');
  const settings = { os: 'win11', kernelVersion: 'auto', ua: { mode: 'default' }, secChUa: { mode: 'default' }, cpu: 4 };
  const profile = buildBrowserRuntimeEnvironment(settings, await resolveTabBrowserProfile({ browserSettings: settings }));
  assert.equal(profile.browserEnvironment.browserVersion, '');
  const args = buildChromiumArgs({ profile });
  assert.equal(args.some((arg) => arg.startsWith('--user-agent=') || arg.startsWith('--hs-user-agent-metadata=')), false);

  const nativeData = { brands: [{ brand: 'Chromium', version: '150' }] };
  const navigator = { userAgent: 'Chrome/150.0.0.0', userAgentData: nativeData };
  vm.runInNewContext(buildBrowserEnvironmentScript(profile.environmentSettings), { navigator });
  assert.equal(navigator.userAgent, 'Chrome/150.0.0.0');
  assert.equal(navigator.userAgentData, nativeData);
  assert.equal(navigator.hardwareConcurrency, 4);
});

test('explicit and legacy UA settings still apply to Chromium launches', async () => {
  const { resolveTabBrowserProfile } = require('../../../src/app/backend/utils/browser-profile');
  const { buildBrowserRuntimeEnvironment } = require('../../../src/app/backend/features/browser/browser-tab-runtime-profile');
  const { buildChromiumArgs } = require('../../../src/app/backend/browser-runtime/chromium-launcher');
  for (const [settings, expected] of [
    [{ ua: { mode: 'custom', value: 'Example/1.0' } }, /Example\/1\.0$/],
    [{ kernelVersion: '142.0.0.0' }, /Chrome\/142\.0\.0\.0/],
    [{ browserVersion: '143' }, /Chrome\/143\.0\.0\.0/],
    [{ os: 'win7' }, /Windows NT 6\.1/],
  ]) {
    const profile = buildBrowserRuntimeEnvironment(settings, await resolveTabBrowserProfile({ browserSettings: settings }));
    const args = buildChromiumArgs({ profile });
    assert.match(args.find((arg) => arg.startsWith('--user-agent=')) || '', expected);
    assert.ok(args.some((arg) => arg.startsWith('--hs-user-agent-metadata=')));
  }
});

test('Chromium launch encodes normalized UA metadata for native request headers', () => {
  const { buildChromiumArgs } = require('../../../src/app/backend/browser-runtime/chromium-launcher');
  const args = buildChromiumArgs({
    profile: {
      environmentSettings: {
        os: 'win11',
        browserVersion: '150.0.0.0',
        deviceName: { mode: 'custom', value: 'Acceptance Device' },
        secChUa: {
          mode: 'custom', mobile: false,
          brands: [{ brand: 'AI-FREE Test', version: '150' }],
        },
      },
    },
    paths: { chromiumData: 'profile-data', downloads: 'downloads' },
    pipeName: 'pipe',
    launchToken: 'token',
  });
  const encoded = args.find((argument) => argument.startsWith('--hs-user-agent-metadata='));
  assert.ok(encoded);
  const metadata = JSON.parse(Buffer.from(encoded.split('=')[1], 'base64').toString('utf8'));
  assert.deepEqual(metadata.brands, [{ brand: 'AI-FREE Test', version: '150' }]);
  assert.equal(metadata.platform, 'Windows');
  assert.equal(metadata.model, 'Acceptance Device');
  assert.equal(metadata.mobile, false);
});

test('Chromium launch excludes the legacy automation extension while preserving regular extensions', () => {
  const manager = {
    getEnabledExtensionPaths: () => [
      'D:\\assets\\extensions\\browser_automation',
      'D:\\assets\\extensions\\transform',
    ],
  };
  assert.deepEqual(resolveChromiumExtensionPaths({
    chromiumExtensionPaths: [
      'D:\\custom\\browser_automation\\',
      'D:\\custom\\regular-extension',
    ],
  }, manager), [
    'D:\\assets\\extensions\\transform',
    'D:\\custom\\regular-extension',
  ]);
});

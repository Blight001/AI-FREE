'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveBrowserGeolocation } = require('../../../src/app/backend/features/browser/browser-ip-geolocation');

test('custom geolocation validates and returns coordinates without querying IP lookup', async () => {
  let lookupCount = 0;
  const location = await resolveBrowserGeolocation({
    mode: 'custom', longitude: 121.47, latitude: 31.23, accuracy: 25,
  }, { lookupByIp: async () => { lookupCount += 1; } });

  assert.equal(lookupCount, 0);
  assert.deepEqual(location, {
    source: 'custom', longitude: 121.47, latitude: 31.23, accuracy: 25,
    sourceIp: '', sourceCountryCode: '', sourceCountry: '', sourceRegion: '', sourceCity: '', timezoneId: '',
  });
});

test('IP geolocation passes the effective proxy to the injected lookup and validates its result', async () => {
  const effectiveProxy = { server: 'http://127.0.0.1:18888', enabled: true };
  let receivedProxy;
  const location = await resolveBrowserGeolocation({ mode: 'ip', accuracy: 400 }, {
    effectiveProxy,
    lookupByIp: async ({ effectiveProxy: proxy }) => {
      receivedProxy = proxy;
      return {
        ip: '203.0.113.12', latitude: '37.7749', longitude: '-122.4194',
        country_code: 'us', country_name: 'United States', region: 'California', city: 'San Francisco',
      };
    },
  });

  assert.equal(receivedProxy, effectiveProxy);
  assert.deepEqual(location, {
    source: 'ip', longitude: -122.4194, latitude: 37.7749, accuracy: 400,
    sourceIp: '203.0.113.12', sourceCountryCode: 'US', sourceCountry: 'United States',
    sourceRegion: 'California', sourceCity: 'San Francisco', timezoneId: '',
  });
});

test('IP lookup failures are explicit and do not include provider errors or proxy credentials', async () => {
  const error = await resolveBrowserGeolocation({ mode: 'ip' }, {
    effectiveProxy: { username: 'private-user', password: 'private-password' },
    lookupByIp: async () => { throw new Error('private-user:private-password@proxy.local failed'); },
  }).then(() => null, (result) => result);

  assert.equal(error.code, 'BROWSER_GEOLOCATION_LOOKUP_FAILED');
  assert.equal(error.message, '无法通过当前网络出口获取地理位置');
  assert.doesNotMatch(error.message, /private-user|private-password|proxy\.local/);
  assert.equal(Object.hasOwn(error, 'cause'), false);
});

test('IP lookup rejects missing and out-of-range coordinates', async (t) => {
  for (const location of [
    { ip: '203.0.113.1', longitude: 181, latitude: 30 },
    { ip: '203.0.113.1', longitude: 10, latitude: -91 },
    { ip: '203.0.113.1', longitude: 'unknown', latitude: 30 },
  ]) {
    await t.test(JSON.stringify(location), async () => {
      await assert.rejects(
        resolveBrowserGeolocation({ mode: 'ip' }, { lookupByIp: async () => location }),
        { code: 'BROWSER_GEOLOCATION_DATA_INVALID' },
      );
    });
  }
});

test('custom coordinates reject invalid values instead of silently clamping them', async () => {
  await assert.rejects(
    resolveBrowserGeolocation({ mode: 'custom', longitude: 181, latitude: 30 }),
    { code: 'BROWSER_GEOLOCATION_DATA_INVALID' },
  );
});


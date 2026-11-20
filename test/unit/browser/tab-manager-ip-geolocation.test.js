'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createTabManagerRuntime } = require('../../../src/app/backend/services/tab-manager-runtime');

test('tab manager passes its IP lookup provider to saved browser settings', async () => {
  const tab = { id: 'geo-profile', browserSettings: {} };
  const tabs = new Map([[tab.id, tab]]);
  const lookups = [];
  const manager = createTabManagerRuntime({
    getTabs: () => tabs,
    lookupByIp: async (options) => {
      lookups.push(options);
      return { ip: '203.0.113.5', longitude: -122.4, latitude: 37.7, accuracy: 1000 };
    },
    resolveTabBrowserProfile: async () => ({ locale: 'en-US', timezoneId: 'America/Los_Angeles' }),
    updateTabs: () => {},
    logger: { warn: () => {} },
  });

  const result = await manager.setTabBrowserSettings(tab.id, {
    geolocation: { permission: 'allow', mode: 'ip' },
  });

  assert.equal(result.ok, true);
  assert.equal(lookups.length, 1);
  assert.equal(tab.browserProfile.geolocationResolution.longitude, -122.4);
  assert.equal(tab.browserProfile.geolocationResolution.sourceIp, '203.0.113.5');
});

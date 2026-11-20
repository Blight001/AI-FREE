'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createBrowserIpGeolocationLookup } = require('../../../src/app/backend/features/browser/browser-ip-geolocation-provider');

function createProviderFixture(t, responseBody = {
  success: true, ip: '203.0.113.5', country_code: 'US', country: 'United States',
  region: 'California', city: 'San Francisco', latitude: 37.77, longitude: -122.42,
  timezone: { id: 'America/Los_Angeles' },
}) {
  const proxyRules = [];
  const requests = [];
  let partitionCalls = 0;
  const requestSession = {
    setProxy: async (options) => proxyRules.push(options),
    closeAllConnections: async () => {},
  };
  const session = { fromPartition: (partition, options) => {
    partitionCalls += 1;
    assert.equal(partition, 'ai-free-browser-ip-geolocation');
    assert.deepEqual(options, { cache: false });
    return requestSession;
  } };
  const net = {
    request: (options) => {
      const request = new EventEmitter();
      request.abort = () => {};
      request.end = () => setImmediate(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.destroy = () => {};
        requests.push({ request, response, options });
        request.emit('login', {}, (...credentials) => { request.credentials = credentials; });
        request.emit('response', response);
        response.emit('data', Buffer.from(JSON.stringify(responseBody)));
        response.emit('end');
      });
      return request;
    },
  };
  t.after(() => requests.forEach(({ request }) => request.removeAllListeners()));
  return {
    lookup: createBrowserIpGeolocationLookup({ net, session }),
    get partitionCalls() { return partitionCalls; },
    proxyRules,
    requests,
  };
}

test('IP geolocation lookup uses the configured effective proxy and keeps proxy credentials in the login callback', async (t) => {
  const fixture = createProviderFixture(t);
  assert.equal(fixture.partitionCalls, 0);
  const location = await fixture.lookup({
    effectiveProxy: {
      enabled: true, server: 'http://proxy.example:8080',
      username: 'proxy-user', password: 'proxy-password',
    },
  });

  assert.equal(fixture.partitionCalls, 1);
  assert.deepEqual(fixture.proxyRules, [{ proxyRules: 'http://proxy.example:8080' }]);
  assert.deepEqual(fixture.requests[0].request.credentials, ['proxy-user', 'proxy-password']);
  assert.equal(fixture.requests[0].options.url, 'https://ipwho.is/?fields=success,message,ip,country_code,country,region,city,latitude,longitude,timezone');
  assert.equal(location.ip, '203.0.113.5');
  assert.equal(JSON.stringify(location).includes('proxy-password'), false);
});

test('IP geolocation lookup distinguishes direct and system routes', async (t) => {
  const fixture = createProviderFixture(t);
  await fixture.lookup({ effectiveProxy: { enabled: false, server: 'direct://' } });
  await fixture.lookup({ effectiveProxy: null });

  assert.deepEqual(fixture.proxyRules, [{ mode: 'direct' }, { mode: 'system' }]);
});

test('IP geolocation lookup rejects unsupported proxy schemes without exposing credentials', async (t) => {
  const fixture = createProviderFixture(t);
  await assert.rejects(fixture.lookup({
    effectiveProxy: { server: 'file://proxy', username: 'secret-user', password: 'secret-pass' },
  }), /代理协议不支持/);
  assert.equal(JSON.stringify(fixture.proxyRules).includes('secret'), false);
});


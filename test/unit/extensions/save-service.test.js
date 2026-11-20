const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../../src/assets/extensions/aixdownloader-9.0.58/save-service.js');

test('settings migrate the old AIX server key and normalize theme', () => {
  assert.deepEqual(service.normalizeSettings({ aixAssetServer: 'http://localhost:58112/', theme: 'nope' }), {
    aixAssetServer: 'http://localhost:58112/', serverUrl: 'http://localhost:58112', theme: 'system'
  });
});

test('invalid server urls fall back to the local service', () => {
  assert.equal(service.normalizeSettings({ serverUrl: 'javascript:alert(1)', theme: 'dark' }).serverUrl, 'http://127.0.0.1:58112');
});

test('sender must belong to the captured tab and frame', () => {
  const capture = { tabId: 17, frameId: 3 };
  assert.equal(service.validSender({ tab: { id: 17 }, frameId: 3 }, capture), true);
  assert.equal(service.validSender({ tab: { id: 17 }, frameId: 0 }, capture), false);
  assert.equal(service.validSender({ tab: { id: 18 }, frameId: 3 }, capture), false);
});

test('request parses API payloads and reports server errors', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  assert.deepEqual(await service.request('http://localhost:58112', '/api/test'), { ok: true });
  global.fetch = async () => new Response(JSON.stringify({ detail: '拒绝访问' }), { status: 403, headers: { 'content-type': 'application/json' } });
  await assert.rejects(() => service.request('http://localhost:58112', '/api/test'), /拒绝访问/);
  global.fetch = originalFetch;
});

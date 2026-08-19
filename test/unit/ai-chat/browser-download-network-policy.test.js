'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  parseProxyUrl,
} = require('../../../src/app/main/services/browser-download-network-policy');

test('parseProxyUrl accepts Clash mixed-port HTTP proxies', () => {
  assert.equal(parseProxyUrl('http://127.0.0.1:7890')?.href, 'http://127.0.0.1:7890/');
  assert.equal(parseProxyUrl('127.0.0.1:7890')?.href, 'http://127.0.0.1:7890/');
  assert.equal(parseProxyUrl('socks5://127.0.0.1:7891'), null);
  assert.equal(parseProxyUrl(''), null);
});

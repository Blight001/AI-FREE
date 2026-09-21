'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');
const { resolveLogoUrl } = require('../../../src/app/shared/app-assets');
const sharedFile = path.join(root, 'src/app/shared/app-assets.js');
const clientFile = path.join(root, 'src/app/frontend/sidebar/client/scripts/logo-assets.js');

function loadLogoClient(pageUrl, scriptUrl) {
  const attributes = new Map();
  const context = vm.createContext({
    URL, window: { location: { href: pageUrl } },
    document: {
      currentScript: { src: scriptUrl },
      querySelectorAll: () => [{
        getAttribute: (key) => attributes.get(key),
        setAttribute: (key, value) => attributes.set(key, value),
      }],
    },
  });
  if (fs.existsSync(sharedFile)) vm.runInContext(fs.readFileSync(sharedFile, 'utf8'), context);
  vm.runInContext(fs.readFileSync(clientFile, 'utf8'), context);
  return { api: context.window.aiFreeLogoAssets, attributes };
}

test('logo resolver rejects unsupported origins and unrelated local trees', () => {
  assert.throws(() => resolveLogoUrl('https://example.com/src/app/page.html'), /local file/);
  assert.throws(() => resolveLogoUrl('file:///D:/unrelated/page.html'), /application tree/);
  assert.throws(() => resolveLogoUrl('not a URL'));
});

test('native icon lookup uses the same source asset and ignores the current working directory', () => {
  const { resolveAppIconPath } = require('../../../src/app/backend/utils/app-icon');
  assert.equal(resolveAppIconPath(), path.join(root, 'src/assets/logo.ico'));
});

for (const [name, appRoot, expected] of [
  ['source', 'file:///D:/AI%20FREE/', 'file:///D:/AI%20FREE/src/assets/logo.ico'],
  ['generated', 'file:///D:/AI%20FREE/.generated/app/', 'file:///D:/AI%20FREE/.generated/app/src/assets/logo.ico'],
  ['packaged', 'file:///D:/AI%20FREE/resources/app.asar/', 'file:///D:/AI%20FREE/resources/resource/logo.ico'],
  ['unpacked', 'file:///D:/AI%20FREE/resources/app.asar.unpacked/', 'file:///D:/AI%20FREE/resources/resource/logo.ico'],
  ['escaped install path', 'file:///D:/%E4%B8%AD%E6%96%87%20%23%25/resources/app.asar/',
    'file:///D:/%E4%B8%AD%E6%96%87%20%23%25/resources/resource/logo.ico'],
]) {
  test(`logo client resolves ${name} independently of page depth and query`, () => {
    for (const page of ['frontend/sidebar/ai-control.html', 'frontend/views/app-shell.html', 'frontend/views/deep/page.html']) {
      const pageUrl = `${appRoot}src/app/${page}?dev=1#panel`;
      const scriptUrl = `${appRoot}src/app/frontend/sidebar/client/scripts/logo-assets.js`;
      const { api, attributes } = loadLogoClient(pageUrl, scriptUrl);
      assert.equal(api.url, expected);
      assert.equal(api.resolve(pageUrl), expected);
      assert.equal(attributes.get('src'), expected);
      assert.equal(api.apply(), expected);
    }
  });
}

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { ensureChromiumSandboxAccess } = require('../../../src/app/backend/browser-runtime/chromium-sandbox-access');
const { ProfileRuntimeStore } = require('../../../src/app/backend/browser-runtime/profile-runtime-store');
const { createIndexedDbTransfer } = require('../../../src/app/backend/features/browser/indexed-db-transfer');
const { listSiteMetadata } = require('../../../src/app/backend/platform/site-data-index');

const selected = 'https://selected.test';
const sourceOtherPort = 'https://selected.test:9443';
const otherPort = 'https://selected.test:8443';
const neighbor = 'https://neighbor.test';
const executablePath = path.resolve(__dirname, '../../../resources/chromium/ai-free-browser.exe');

async function open(root) {
  const browser = await chromium.launchPersistentContext(root, {
    executablePath, headless: true, chromiumSandbox: true, args: ['--enable-logging=stderr'],
  });
  await browser.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Fixture</title>' }));
  return browser;
}

async function database(browser, origin, value) {
  const page = browser.pages()[0];
  await page.goto(origin);
  return page.evaluate(async (value) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('fixture', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('records');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (value) {
        await new Promise((resolve, reject) => {
          const tx = db.transaction('records', 'readwrite');
          tx.objectStore('records').put(new Blob([value]), 'data');
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      }
      const blob = await new Promise((resolve, reject) => {
        const request = db.transaction('records').objectStore('records').get('data');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return blob ? blob.text() : null;
    } finally { db.close(); }
  }, value);
}

async function seed(source, target) {
  const a = await open(source.chromiumData);
  try {
    await database(a, selected, 'A original');
    await database(a, sourceOtherPort, 'A second origin');
  } finally { await a.close(); }
  const b = await open(target.chromiumData);
  try {
    await database(b, otherPort, 'B same host and different port');
    await database(b, neighbor, 'B neighbor');
    await b.addCookies([{ url: neighbor, name: 'test-account', value: 'B only', expires: Date.now() / 1000 + 3600 }]);
    await b.pages()[0].evaluate(() => localStorage.setItem('account', 'B only'));
  } finally { await b.close(); }
}

async function verify(source, target) {
  const a = await open(source.chromiumData);
  try {
    const b = await open(target.chromiumData);
    try {
      assert.equal(await database(b, selected), 'A original');
      assert.equal(await database(b, sourceOtherPort), 'A second origin');
      assert.equal(await database(b, selected, 'B edit'), 'B edit');
      assert.equal(await database(a, selected), 'A original');
      assert.equal(await database(b, otherPort), 'B same host and different port');
      assert.equal(await database(b, neighbor), 'B neighbor');
      assert.equal((await b.cookies(neighbor))[0]?.value, 'B only');
      assert.equal(await b.pages()[0].evaluate(() => localStorage.getItem('account')), 'B only');
    } finally { await b.close(); }
  } finally { await a.close(); }
}

test('real Chromium copies all IndexedDB origins for the selected host and keeps both profiles independent', { timeout: 60000 }, async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aifree-idb-accept-'));
  try {
    assert.equal(ensureChromiumSandboxAccess(executablePath).ok, true);
    const store = new ProfileRuntimeStore({ rootDir });
    const source = store.ensureProfile({ profileId: 'a' });
    const target = store.ensureProfile({ profileId: 'b' });
    await seed(source, target);
    const senderFrame = { url: 'file:///app/frontend/views/app-shell.html' };
    const sender = { mainFrame: senderFrame, isDestroyed: () => false };
    const handler = createIndexedDbTransfer({ ui: { browserRuntimeManager: { store }, getMainWindow: () => ({ webContents: sender }) },
      readHistory: () => [{ id: 'a' }, { id: 'b' }], resolveProfileId: (record) => record.id });
    const transfer = (options) => handler({ sender, senderFrame }, { sourceId: 'a', targetId: 'b', host: 'selected.test', ...options });
    const metadata = await listSiteMetadata(source.chromiumData);
    assert.deepEqual(metadata.sites.find(site => site.host === 'selected.test').indexedDbOrigins, [selected, sourceOtherPort]);
    const preview = await transfer();
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.deepEqual(preview.data.origins, [selected, sourceOtherPort]);
    assert.equal((await transfer({ revision: preview.data.revision })).ok, true);
    assert.equal((await transfer()).error.code, 'SITE_DATABASE_CONFLICT');
    await verify(source, target);
  } finally { await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
});

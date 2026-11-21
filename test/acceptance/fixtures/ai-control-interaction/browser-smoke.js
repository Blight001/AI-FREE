'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { resolveChromiumResourcesPath } = require('../../../../src/app/backend/config/paths');
const { startFixture } = require('./server');

test('Chromium can read back one commit after B loses its final receipt', { timeout: 25000 }, async () => {
  const fixture = await startFixture();
  let browser;
  try {
    const executablePath = path.join(resolveChromiumResourcesPath({ isPackaged: false }), 'chromium', 'ai-free-browser.exe');
    browser = await chromium.launch({ executablePath, headless: true, timeout: 12000 });
    const context = await browser.newContext({ viewport: { width: 320, height: 600 } });
    context.setDefaultTimeout(5000);
    const [a, b, c] = await Promise.all(Array.from({ length: 3 }, () => context.newPage()));
    await Promise.all([a.goto(fixture.urls.a), b.goto(fixture.urls.dropOnce), c.goto(fixture.urls.c)]);
    const images = await a.locator('img').evaluateAll((elements) => elements.map((img) => img.naturalWidth));
    assert.deepEqual(images, [96, 96]);
    await b.locator('#readback-status').getByText('verified', { exact: true }).waitFor();
    await b.locator('#fixture-file').setInputFiles(fixture.files.red.path);
    await b.locator('#selection-status').getByText('selected', { exact: true }).waitFor();
    await b.locator('#fixture-submit').click();
    await b.locator('#receipt-status').getByText('unknown', { exact: true }).waitFor();
    assert.equal(await b.locator('#received-count').textContent(), '0');
    await b.locator('#fixture-read').click();
    await b.locator('#received-count').getByText('1', { exact: true }).waitFor();
    assert.equal(await b.locator('#received-sha256').textContent(), fixture.files.red.sha256);
    assert.equal(await b.locator('#dropped-receipts').textContent(), '1');
    assert.equal(await b.locator('#receipt-status').textContent(), 'unknown');
    await c.locator('#fixture-read').click();
    await c.locator('#readback-status').getByText('verified', { exact: true }).waitFor();
    assert.equal(await c.locator('#selection-count').textContent(), '0');
    assert.equal(await c.locator('#received-count').textContent(), '0');
    assert.ok(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  } finally {
    try { await browser?.close(); } finally { await fixture.close(); }
  }
});

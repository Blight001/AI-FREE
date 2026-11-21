'use strict';

const assert = require('node:assert/strict');
const { dispatchControl, poll, rendererProbe } = require('../flows/electron-controls');

function readCategories() {
  const dialog = /** @type {HTMLDialogElement} */ (document.getElementById('provider-category-dialog'));
  const tabs = document.querySelector('.provider-account-tabs');
  const active = tabs.querySelector('[aria-selected="true"]');
  const panel = document.getElementById(active.getAttribute('aria-controls'));
  return {
    custom: [...tabs.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent).slice(2),
    addAfter: tabs.querySelector('#provider-category-add').previousElementSibling?.textContent,
    active: active.textContent,
    id: active.id,
    panel: `#${panel.id}`,
    rows: panel.querySelector('.provider-account-list').textContent,
    modal: dialog.open,
    warning: dialog.querySelector('.provider-category-warning').textContent,
    focused: document.activeElement.textContent,
    error: dialog.querySelector('[role="status"]').textContent,
  };
}

function setValue(selector, value) {
  /** @type {HTMLInputElement} */ (document.querySelector(selector)).value = value;
}

function openContext(tabId) {
  const tab = document.getElementById(tabId);
  tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  return document.getElementById('provider-category-menu').matches(':popover-open');
}

async function checkProviderCategories(webContents) {
  const run = rendererProbe(webContents);
  const read = () => run(readCategories);
  const click = async (selector) => assert.ok((await run(dispatchControl, selector)).sent, selector);
  const section = '#provider-category-dialog';
  const name = `${section} [name="name"]`;
  const accept = () => click(`${section} [type="submit"]`);
  assert.equal((await read()).addAfter, 'Microsoft');
  assert.equal(await run(openContext, 'provider-microsoft-tab'), false, 'Built-in category must not have destructive actions');
  await click('#provider-category-add');
  assert.ok((await read()).modal);
  await run(setValue, name, 'Microsoft');
  await accept();
  assert.equal((await poll(read, (state) => state.error)).error, '已有同名栏目');
  await run(setValue, name, 'QQ');
  await accept();
  const qq = await poll(read, (state) => !state.modal && state.active === 'QQ');
  assert.equal(qq.active, 'QQ');
  assert.equal(qq.addAfter, 'QQ');
  await click(`${qq.panel} .provider-add-account`);
  await run(setValue, '#provider-account-form [name="email"]', '123456789');
  await run(setValue, '#provider-account-form [name="password"]', 'fixture-custom');
  await click('#provider-account-form [type="submit"]');
  assert.match((await poll(read, (state) => state.rows.includes('123456789'))).rows, /123456789/);
  assert.ok(await run(openContext, qq.id));
  await click('#provider-category-menu [data-action="rename"]');
  await run(setValue, name, 'QQ 工作');
  await accept();
  const renamed = await poll(read, (state) => !state.modal && state.active === 'QQ 工作');
  assert.equal(renamed.active, 'QQ 工作');
  assert.equal(renamed.id, qq.id);
  assert.match(renamed.rows, /123456789/);
  assert.equal(renamed.addAfter, 'QQ 工作');

  assert.ok(await run(openContext, qq.id));
  await click('#provider-category-menu [data-action="remove"]');
  const pending = await read();
  assert.ok(pending.modal && pending.warning.includes('所有账号') && pending.focused === '取消');
  await click(`${section} [type="button"]`);
  assert.match((await read()).rows, /123456789/);
  assert.ok(await run(openContext, qq.id));
  await click('#provider-category-menu [data-action="remove"]');
  await accept();
  const deleted = await poll(read, (state) => !state.modal && !state.custom.length);
  assert.deepEqual(deleted.custom, []);
  assert.equal(deleted.addAfter, 'Microsoft');
  await click('#provider-microsoft-tab');
  assert.match((await poll(read, (state) => state.rows.includes('test-account@example.test'))).rows, /test-account@example\.test/);
}

module.exports = { checkProviderCategories };

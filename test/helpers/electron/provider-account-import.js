'use strict';

const assert = require('node:assert/strict');
const { dispatchControl, poll, rendererProbe } = require('../flows/electron-controls');

function pasteImport(value) {
  const input = /** @type {HTMLTextAreaElement} */ (document.querySelector('#provider-account-import textarea'));
  input.value = value;
}

function readImport() {
  const panel = document.getElementById('provider-account-import');
  const form = panel.closest('form');
  const note = form.querySelector('[name="note"]');
  const textarea = /** @type {HTMLTextAreaElement} */ (panel.querySelector('textarea'));
  return {
    modal: panel.closest('dialog').open,
    title: form.querySelector('h2').textContent,
    textareaBelowNote: textarea.getBoundingClientRect().top > note.getBoundingClientRect().bottom,
    standaloneImport: [...document.querySelectorAll('#provider-microsoft-panel button')].some((button) => button.textContent === '文本导入'),
    manualSaveVisible: form.querySelector('[type="submit"]').getClientRects().length > 0,
    text: panel.innerText,
    sourceCleared: !textarea.value,
    status: panel.querySelector('[role="status"]').textContent,
    accounts: document.querySelector('#provider-microsoft-panel .provider-account-list').textContent,
  };
}

async function checkProviderAccountImport(webContents, existing) {
  const run = rendererProbe(webContents);
  const read = () => run(readImport);
  const click = async (selector) => assert.ok((await run(dispatchControl, selector)).sent, selector);
  const invoke = (button) => click(`#provider-account-import .provider-import-${button}`);
  const correct = 'keep@example.test';
  const wrong = 'remove-later@example.test';
  const excluded = 'exclude@example.test';
  const text = [
    `${correct}----synthetic-password----00000000-0000-0000-0000-000000000000----synthetic-extra`,
    `账号：${wrong}`, '邮箱密码：synthetic-mail-password',
    `${excluded}----fixture-only`, `${existing}----fixture-only`,
  ].join('\n');

  await click('#provider-microsoft-tab');
  const open = () => click('#provider-microsoft-panel .provider-add-account');
  const close = () => click('#provider-account-form .provider-cancel');
  await open();
  const initial = await read();
  assert.ok(initial.modal && initial.title.includes('Microsoft'));
  assert.ok(initial.textareaBelowNote && initial.manualSaveVisible && !initial.standaloneImport);
  await run(pasteImport, text);
  await invoke('preview');
  const preview = await read();
  assert.ok(preview.sourceCleared && preview.text.includes(correct) && !preview.text.includes('synthetic'));
  assert.ok(!preview.manualSaveVisible);
  assert.ok(!preview.accounts.includes(correct), 'Preview must not save accounts');
  await close();
  assert.equal((await read()).modal, false);
  assert.ok(!(await read()).accounts.includes(correct), 'Cancel must not save accounts');

  await open();
  await run(pasteImport, text);
  await invoke('preview');
  await click(`[aria-label="移除 ${excluded}"]`);
  assert.ok(!(await read()).text.includes(excluded));
  await invoke('confirm');
  const imported = await poll(read, (state) => state.accounts.includes(wrong));
  assert.ok(imported.text.includes('已存在，未覆盖') && imported.accounts.includes(correct));
  assert.ok(!imported.accounts.includes(excluded));
  await click(`[aria-label="删除 ${wrong}"]`);
  assert.ok((await read()).accounts.includes(wrong), 'Delete requires confirmation');
  const confirmDelete = () => click(`[aria-label="确认删除 ${wrong}"]`);
  await confirmDelete();
  const failed = await poll(read, (state) => state.text.includes('删除失败'));
  assert.ok(failed.text.includes('删除失败') && failed.accounts.includes(wrong));
  await confirmDelete();
  const deleted = await poll(read, (state) => state.accounts.includes(correct) && !state.accounts.includes(wrong));
  assert.ok(deleted.text.includes('已删除') && deleted.accounts.includes(correct) && deleted.accounts.includes(existing));
  assert.ok(!deleted.text.includes('删除失败'));
  await close();
  await click('#provider-google-tab');
}

module.exports = { checkProviderAccountImport };

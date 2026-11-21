'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, ipcMain, safeStorage } = require('electron');
const { dispatchControl, poll, rendererProbe } = require('../flows/electron-controls');
const { checkProviderAccountImport } = require('./provider-account-import');
const { checkProviderCategories } = require('./provider-categories');

const email = 'test-account@example.test';
const note = '备用账号 <工作组>';

function bindProviderAccountFixture(layout, webContents) {
  const backend = path.join(layout.root, 'src/app/backend');
  const { ProviderAccountVault } = require(path.join(backend, 'features/account/provider-account-vault'));
  const { registerProviderAccountDetails } = require(path.join(backend, 'features/account/register-provider-account-details'));
  const { createIpcRegistry } = require(path.join(backend, 'ipc/registry'));
  const filePath = path.join(app.getPath('userData'), 'fixture-provider-accounts.json');
  const vault = new ProviderAccountVault({ fs, path, safeStorage, filePath });
  const ipc = createIpcRegistry(ipcMain);
  registerProviderAccountDetails(ipc, vault, () => webContents);
  webContents.once('destroyed', () => ipc.dispose());
  let failFirstSave = true;
  let failFirstDelete = true;
  ipc.handle('provider-accounts-list', (_event, { provider }) => ({ ok: true, accounts: vault.list(provider) }));
  ipc.handle('provider-accounts-save', (_event, input) => {
    if (failFirstSave) {
      failFirstSave = false;
      return { ok: false, error: { message: 'Fixture save failed' } };
    }
    try {
      return { ok: true, account: vault.save(input) };
    } catch (error) {
      return { ok: false, error: { message: error.message } };
    }
  });
  ipc.handle('provider-accounts-delete', (_event, { provider, id }) => {
    if (failFirstDelete) {
      failFirstDelete = false;
      return { ok: false };
    }
    vault.remove(provider, id);
    return { ok: true };
  });
}

function readDialog() {
  const form = /** @type {HTMLFormElement} */ (document.getElementById('provider-account-form'));
  const dialog = form.closest('dialog');
  const fields = new FormData(form);
  const noteInput = /** @type {HTMLInputElement | null} */ (form.elements.namedItem('note'));
  const bounds = dialog?.getBoundingClientRect();
  const homeRight = document.getElementById('browser-empty-state').getBoundingClientRect().right;
  const microsoftList = document.querySelector('#provider-microsoft-panel .provider-account-list');
  return {
    modal: dialog?.open === true,
    visible: form.getBoundingClientRect().width > 0,
    linkedAccountsVisible: /关联的浏览器账号|账号123456/.test(document.getElementById('home-accounts').innerText),
    title: form.querySelector('h2').textContent,
    fitsHome: bounds?.left >= 0 && bounds?.right <= homeRight,
    centered: Math.abs(bounds?.left + bounds?.right - homeRight) < 2,
    reservedSpace: Math.round(innerWidth - homeRight),
    focused: document.activeElement.getAttribute('name'),
    empty: !fields.get('email') && !fields.get('password') && !fields.get('note'),
    noteLabel: noteInput?.labels?.[0]?.textContent.trim(),
    noteValue: noteInput?.value,
    noteOptional: noteInput?.required === false,
    status: form.querySelector('#provider-account-save-status').textContent,
    editEmail: form.querySelector('.provider-account-edit-email').textContent,
    credentialsVisible: form.querySelector('[name="password"]').getClientRects().length > 0,
    importVisible: form.querySelector('textarea').getClientRects().length > 0,
    microsoftList: microsoftList.textContent,
    microsoftListHasLink: !!microsoftList.querySelector('a'),
    googleList: document.querySelector('#provider-google-panel .provider-account-list').textContent,
  };
}

async function checkSavedAccountControls(run, read, click) {
  const panel = '#provider-microsoft-panel';
  const eye = `${panel} [aria-label="查看密码"]`;
  const hide = `${panel} [aria-label="隐藏密码"]`;
  assert.doesNotMatch((await read()).microsoftList, /fixture-only|密码已加密保存/);
  assert.equal(await run((selector) => {
    const row = document.querySelector(`${selector} .provider-account-row`);
    const login = row.querySelector('strong').getBoundingClientRect();
    const password = row.querySelector('[aria-label="查看密码"]').getBoundingClientRect();
    return password.left >= login.right && password.bottom > login.top && password.top < login.bottom;
  }, panel), true, 'Password must be alongside the account, not below it');
  await click(eye);
  await poll(read, (state) => state.microsoftList.includes('fixture-only'));
  await click(hide);
  assert.ok(!(await read()).microsoftList.includes('fixture-only'));
  await click(eye);
  await poll(read, (state) => state.microsoftList.includes('fixture-only'));
  await click('#home-browsers-tab');
  assert.ok(!(await read()).microsoftList.includes('fixture-only'));
  await click('#home-accounts-tab');
  await click(`${panel} .provider-edit-note`);
  const editing = await read();
  assert.ok(editing.modal && editing.editEmail === email && editing.noteValue === note);
  assert.ok(!editing.credentialsVisible && !editing.importVisible);
  const setNote = (value) => run((text) => {
    /** @type {HTMLInputElement} */ (document.querySelector('#provider-account-form [name="note"]')).value = text;
  }, value);
  await setNote('更新后的备注');
  await click('#provider-account-form [type="submit"]');
  await poll(read, (state) => !state.modal && state.microsoftList.includes('更新后的备注'));
  await click(`${panel} .provider-edit-note`);
  await setNote('');
  await click('#provider-account-form [type="submit"]');
  await poll(read, (state) => !state.modal && state.microsoftList.includes('添加备注'));
  await click(eye);
  await poll(read, (state) => state.microsoftList.includes('fixture-only'));
  await click('#provider-google-tab');
  assert.ok(!(await read()).microsoftList.includes('fixture-only'));
}

function fillForm(address, note) {
  const form = /** @type {HTMLFormElement} */ (document.getElementById('provider-account-form'));
  const emailInput = /** @type {HTMLInputElement} */ (form.elements.namedItem('email'));
  const passwordInput = /** @type {HTMLInputElement} */ (form.elements.namedItem('password'));
  const noteInput = /** @type {HTMLInputElement} */ (form.elements.namedItem('note'));
  emailInput.value = address;
  passwordInput.value = 'fixture-only';
  noteInput.value = note;
}

async function checkProviderAccountDialog(webContents) {
  const run = rendererProbe(webContents);
  const read = () => run(readDialog);
  const click = async (selector) => assert.equal((await run(dispatchControl, selector)).sent, true, selector);
  await click('#home-accounts-tab');
  const initial = await read();
  assert.equal(initial.visible, false, 'Add form must not appear inline');
  assert.equal(initial.linkedAccountsVisible, false, 'Linked browser accounts must not appear in the account panel');
  await click('#provider-google-panel .provider-add-account');
  const google = await read();
  assert.ok(google.modal && google.visible && google.fitsHome && google.title.includes('Google'), 'Adding Google accounts must open a modal in the home workspace');
  assert.equal(google.focused, 'email');
  assert.equal(google.noteLabel, '备注（可选）');
  assert.ok(google.noteOptional);
  webContents.send('sidebar-collapse');
  const collapsed = await poll(read, (state) => state.reservedSpace === 0);
  assert.ok(collapsed.modal && collapsed.centered && collapsed.reservedSpace === 0);
  webContents.send('sidebar-expand');
  const expanded = await poll(read, (state) => state.reservedSpace > 0);
  assert.ok(expanded.modal && expanded.centered && expanded.reservedSpace > 0);
  await run(fillForm, '', note);
  await click('#provider-account-form .provider-cancel');
  assert.equal((await read()).visible, false);
  await click('#provider-microsoft-tab');
  await click('#provider-microsoft-panel .provider-add-account');
  const microsoft = await read();
  assert.ok(microsoft.modal && microsoft.empty && microsoft.title.includes('Microsoft'));
  await run(fillForm, email, note);
  await click('#provider-account-form [type="submit"]');
  const failed = await poll(read, (state) => state.status === 'Fixture save failed');
  assert.ok(failed.modal && !failed.empty && failed.status === 'Fixture save failed');
  assert.equal(failed.noteValue, note);
  await click('#provider-account-form [type="submit"]');
  const saved = await poll(read, (state) => !state.visible && state.microsoftList.includes(email));
  assert.ok(!saved.modal && !saved.visible && saved.empty && saved.microsoftList.includes(email));
  assert.ok(!saved.googleList.includes(email));
  assert.ok(saved.microsoftList.includes(`备注：${note}`));
  assert.equal(saved.microsoftListHasLink, false);
  await checkSavedAccountControls(run, read, click);
  await click('#provider-google-panel .provider-add-account');
  await run(() => document.getElementById('home-browsers-tab').click());
  assert.equal((await read()).modal, false, 'Navigating away must release modal focus');
  await click('#home-accounts-tab');
  await click('#provider-google-panel .provider-add-account');
  assert.ok((await read()).modal, 'Modal must reopen after returning to the account panel');
  await click('#provider-account-form .provider-cancel');
  await checkProviderAccountImport(webContents, email);
  await checkProviderCategories(webContents);
  await click('#home-browsers-tab');
}

module.exports = { checkProviderAccountDialog, bindProviderAccountFixture };

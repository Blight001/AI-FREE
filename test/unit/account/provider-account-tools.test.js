'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AppError } = require('../../../src/app/contracts/ipc-result');
const { createProviderAccountTools } = require('../../../src/app/backend/features/account/provider-account-tools');
const { ProviderAccountVault } = require('../../../src/app/backend/features/account/provider-account-vault');

const username = 'fixture-login@example.test';
const password = 'fixture-password';
const inbox = 'https://example.test/mocked-sms';
const origin = 'https://login.example.test';

function setup(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-account-tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString(),
  };
  const vault = new ProviderAccountVault({ fs, path, safeStorage, filePath: path.join(root, 'vault.json') });
  const { id } = vault.save({ provider: 'google', email: username, password, smsUrl: inbox });
  const ref = { provider: 'google', id };
  const selection = { ...ref, field: 'password', field_name: 'secret', change_browser: 'native:test', origin };
  const accountTools = createProviderAccountTools({
    vault,
    bridge: {
      getConnection: (id) => ({ id, browserProcessId: 777, name: 'fixture browser' }),
      dispatch: async () => ({ activeTab: { url: `${origin}/form`, pageToken: 'fixture-page' } }),
    },
    runtime: {},
    onChanged: () => {},
    openEditor: (input) => ({ editorRequested: true, ...input }),
    confirm: async () => { throw new AppError('ACCOUNT_CONFIRMATION_DECLINED', '取消'); },
    ...overrides,
  });
  const execute = (action, input) => accountTools.execute('account_manage', { action, ...input });
  return { vault, accountTools, execute, ref, selection };
}

test('MCP exposes one account tool and rejects invalid actions without side effects', async (t) => {
  const { accountTools, execute, ref, vault } = setup(t, {
    openEditor: () => assert.fail('invalid input must not open the editor'),
    onChanged: () => assert.fail('invalid input must not modify the vault'),
  });
  assert.deepEqual(accountTools.tools.map(({ name }) => name), ['account_manage']);
  assert.equal(accountTools.has('account_manage'), true);
  assert.equal(accountTools.has('account_delete'), false);
  assert.ok((await execute('categories')).data.categories.some(({ id }) => id === ref.provider));
  for (const input of [
    {}, { action: 'unknown' }, { action: 'constructor' }, { action: 'list' },
    { action: 'add', ...ref }, { action: 'delete', ...ref, note: 'other action' },
    { action: 'purge', id: ref.id, provider: ref.provider }, { action: 'trash', password },
  ]) {
    assert.equal((await accountTools.execute('account_manage', input)).error.code, 'ACCOUNT_INVALID_INPUT');
  }
  assert.equal(vault.list(ref.provider).length, 1);
  assert.deepEqual(vault.listTrash(), []);
});

test('account tools expose only masked identities and route new credentials to the local editor', async (t) => {
  const { execute, vault, ref } = setup(t);
  const listed = await execute('list', { provider: 'google' });
  assert.deepEqual(listed, { ok: true, data: { accounts: [{ id: ref.id, maskedAccount: 'f•••@e•••' }] } });
  assert.equal((await execute('add', { provider: 'google', password })).error.code, 'ACCOUNT_INVALID_INPUT');
  assert.deepEqual((await execute('add', { provider: 'google' })).data, { editorRequested: true, provider: 'google' });
  assert.deepEqual((await execute('update', ref)).data, { editorRequested: true, ...ref });
  const updated = await execute('update', { ...ref, note: 'metadata fixture' });
  assert.equal(updated.ok, true);
  assert.equal(Object.hasOwn(updated.data.account, 'note'), false);
  assert.equal(vault.list('google')[0].note, 'metadata fixture');
  assert.equal(vault.getPassword('google', ref.id), password);
});

test('MCP requires approval to move an account to the recycle bin and to purge it', async (t) => {
  let approved = false;
  let notifications = 0;
  const { execute, ref, vault } = setup(t, {
    confirm: async () => {
      if (!approved) throw new AppError('ACCOUNT_CONFIRMATION_DECLINED', '取消');
    },
    onChanged: () => { notifications += 1; },
  });
  assert.equal((await execute('delete', ref)).error.code, 'ACCOUNT_CONFIRMATION_DECLINED');
  assert.equal(vault.getPassword(ref.provider, ref.id), password);
  assert.deepEqual(vault.listTrash(), []);
  assert.equal(notifications, 0);
  approved = true;
  assert.deepEqual(await execute('delete', ref), { ok: true, data: { deleted: true } });
  assert.equal(notifications, 1);
  const { data } = await execute('trash');
  assert.deepEqual(Object.keys(data.accounts[0]).sort(), ['category', 'deletedAt', 'id', 'maskedAccount', 'provider']);
  approved = false;
  assert.equal((await execute('purge', { id: data.accounts[0].id })).error.code, 'ACCOUNT_CONFIRMATION_DECLINED');
  assert.equal(notifications, 1);
  assert.equal((await execute('restore', { id: data.accounts[0].id })).data.account.id, ref.id);
  assert.equal(vault.getPassword(ref.provider, ref.id), password);
  approved = true;
  await execute('delete', ref);
  const [archived] = vault.listTrash();
  assert.deepEqual(await execute('purge', { id: archived.id }), { ok: true, data: { deleted: true } });
  assert.deepEqual(vault.listTrash(), []);
});

test('credentials dispatch once without confirmation through the bound native path and do not appear in results or failures', async (t) => {
  let result = { result: { success: true, filled: true, value: password } };
  const calls = [];
  const { execute, selection, vault, ref } = setup(t, {
    confirm: async () => assert.fail('fill must not request confirmation'),
    runtime: { dispatchAutomationByProcessId: async (...args) => {
      calls.push(args);
      if (result instanceof Error) throw result;
      return result;
    } },
  });
  assert.equal((await execute('fill', { ...selection, origin: 'https://wrong.example.test' })).error.code, 'ACCOUNT_TARGET_MISMATCH');
  assert.equal((await execute('fill', { ...selection, field_id: 'conflicting' })).error.code, 'ACCOUNT_FIELD_REQUIRED');
  assert.equal(calls.length, 0);
  assert.deepEqual(await execute('fill', selection), { ok: true, data: { filled: true } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 777);
  assert.equal(calls[0][1], 'fill-account-field');
  assert.equal(calls[0][2].value, password);
  assert.equal(calls[0][3].expectedPageToken, 'fixture-page');
  result = Object.assign(new Error(password), { code: 'BROWSER_TARGET_CHANGED' });
  const failed = await execute('fill', selection);
  assert.equal(failed.error.code, 'ACCOUNT_TARGET_CHANGED');
  assert.equal(JSON.stringify(failed).includes(password), false);
  vault.remove(ref.provider, ref.id);
  assert.equal((await execute('fill', selection)).error.code, 'ACCOUNT_NOT_FOUND');
  assert.equal(calls.length, 2);
});

test('changing the account identity while deletion awaits approval invalidates that approval', async (t) => {
  const replacement = 'updated@example.test';
  const { execute, vault, ref } = setup(t, {
    confirm: async () => vault.updateCredentials({ ...ref, email: replacement, password: '', note: '' }),
  });
  assert.equal((await execute('delete', ref)).error.code, 'ACCOUNT_CHANGED');
  assert.equal(vault.list(ref.provider)[0].email, replacement);
  assert.deepEqual(vault.listTrash(), []);
});

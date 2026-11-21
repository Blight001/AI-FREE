'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProviderAccountVault } = require('../../../src/app/backend/features/account/provider-account-vault');

function createVault() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-provider-vault-'));
  const filePath = path.join(directory, 'provider-accounts.json');
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => value.toString().replace(/^encrypted:/, ''),
  };
  return { directory, filePath, vault: new ProviderAccountVault({ fs, path, safeStorage, filePath }) };
}

test('provider accounts are encrypted at rest, separated by provider, and listed without passwords', (t) => {
  const fixture = createVault();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const google = fixture.vault.save({ provider: 'google', email: ' Test@Example.com ', password: 'secret-google', smsUrl: 'https://sms.example/inbox' });
  fixture.vault.save({ provider: 'microsoft', email: 'work@example.com', password: 'secret-microsoft' });

  const contents = fs.readFileSync(fixture.filePath, 'utf8');
  assert.equal(contents.includes('secret-google'), false);
  assert.equal(contents.includes('secret-microsoft'), false);
  assert.deepEqual(fixture.vault.list('google'), [{
    id: google.id, email: 'test@example.com', smsUrl: 'https://sms.example/inbox',
    note: 'https://sms.example/inbox', hasPassword: true,
  }]);
  assert.equal(fs.readFileSync(fixture.filePath, 'utf8'), contents, 'Reading legacy accounts must not rewrite the file');
  assert.equal(fixture.vault.list('microsoft')[0].email, 'work@example.com');
  assert.equal(fixture.vault.list('microsoft')[0].note, '');
  assert.equal(Object.hasOwn(fixture.vault.list('google')[0], 'password'), false);
});

test('provider account notes accept plain text and persist in the encrypted vault', (t) => {
  const fixture = createVault();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const note = '备用账号 <工作组>';
  const account = fixture.vault.save({ provider: 'microsoft', email: 'work@example.com', password: 'fixture-only', note: ` ${note} ` });
  assert.equal(account.note, note);
  assert.equal(account.smsUrl, '');
  assert.deepEqual(fixture.vault.list('microsoft'), [account]);
  assert.ok(!fs.readFileSync(fixture.filePath, 'utf8').includes(note));
});

test('provider vault rejects duplicate accounts and unsafe SMS URLs without changing stored data', (t) => {
  const fixture = createVault();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  fixture.vault.save({ provider: 'google', email: 'a@example.com', password: 'secret' });
  assert.throws(() => fixture.vault.save({ provider: 'google', email: 'A@example.com', password: 'other' }), /already exists/);
  assert.throws(() => fixture.vault.save({ provider: 'microsoft', email: 'b@example.com', password: 'secret', smsUrl: 'javascript:alert(1)' }), /HTTP or HTTPS/);
  assert.throws(() => fixture.vault.list('other'), /provider/);
  assert.equal(fixture.vault.list('google').length, 1);
});

test('provider account deletion only removes the matching provider record', (t) => {
  const fixture = createVault();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const google = fixture.vault.save({ provider: 'google', email: 'same@example.com', password: 'secret' });
  const microsoft = fixture.vault.save({ provider: 'microsoft', email: 'same@example.com', password: 'secret' });
  fixture.vault.remove('google', google.id);
  assert.equal(fixture.vault.list('google').length, 0);
  assert.equal(fixture.vault.list('microsoft')[0].id, microsoft.id);
});

test('password lookup and note updates are scoped to one account without replacing its credentials', (t) => {
  const { directory, filePath, vault } = createVault();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { id } = vault.save({ provider: 'google', email: 'a@example.com', password: 'fixture-one', smsUrl: 'https://sms.example/inbox' });
  const other = vault.save({ provider: 'microsoft', email: 'a@example.com', password: 'fixture-two' });
  assert.equal(vault.getPassword('google', id), 'fixture-one');
  assert.throws(() => vault.getPassword('microsoft', id), /not found/);
  assert.throws(() => vault.getPassword('unknown', id), /provider/);
  const before = fs.readFileSync(filePath, 'utf8');
  assert.throws(() => vault.updateNote('microsoft', id, 'wrong provider'), /not found/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  assert.equal(vault.updateNote('google', id, ' updated ').note, 'updated');
  const cleared = vault.updateNote('google', id, '');
  assert.equal(cleared.note, '');
  assert.equal(cleared.smsUrl, 'https://sms.example/inbox');
  assert.equal(Object.hasOwn(cleared, 'password'), false);
  assert.equal(vault.getPassword('google', id), 'fixture-one');
  assert.equal(vault.getPassword('microsoft', other.id), 'fixture-two');
  assert.deepEqual(vault.list('google'), [cleared]);
  assert.deepEqual(vault.list('microsoft'), [other]);
});

test('custom categories persist, rename without moving accounts, and delete only their own records', (t) => {
  const { directory, filePath, vault } = createVault();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const builtIn = vault.save({ provider: 'google', email: 'a@example.com', password: 'fixture-one' });
  const before = fs.readFileSync(filePath, 'utf8');
  assert.deepEqual(vault.listCategories().map(({ id }) => id), ['google', 'microsoft']);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  const qq = vault.createCategory(' QQ ');
  assert.equal(qq.name, 'QQ');
  assert.throws(() => vault.createCategory(' qQ '), { code: 'CATEGORY_NAME_EXISTS' });
  assert.throws(() => vault.createCategory('Microsoft'), { code: 'CATEGORY_NAME_EXISTS' });
  assert.throws(() => vault.createCategory(' '), { code: 'INVALID_CATEGORY_NAME' });
  assert.throws(() => vault.removeCategory('google'), { code: 'BUILT_IN_CATEGORY' });
  assert.throws(() => vault.renameCategory('microsoft', 'Office'), { code: 'BUILT_IN_CATEGORY' });
  const saved = vault.save({ provider: qq.id, email: '123456789', password: 'fixture-qq' });
  assert.throws(() => vault.save({ provider: 'google', email: saved.email, password: 'fixture' }), /valid email/);
  assert.throws(() => vault.save({ provider: qq.id, email: 'https://example.test', password: 'fixture' }), /valid account/);
  const reopened = new ProviderAccountVault({ fs, path, safeStorage: vault.safeStorage, filePath });
  assert.deepEqual(reopened.list(qq.id), [saved]);
  assert.equal(reopened.renameCategory(qq.id, 'QQ 工作').id, qq.id);
  assert.equal(vault.listCategories().at(-1).name, 'QQ 工作');
  assert.equal(vault.updateNote(qq.id, saved.id, 'fixture note').note, 'fixture note');
  assert.equal(vault.getPassword(qq.id, saved.id), 'fixture-qq');
  vault.removeCategory(qq.id);
  assert.throws(() => reopened.list(qq.id), { code: 'INVALID_PROVIDER' });
  assert.deepEqual(reopened.list('google'), [builtIn]);
  const sameName = reopened.createCategory('QQ 工作');
  assert.notEqual(sameName.id, qq.id);
  assert.deepEqual(vault.list(sameName.id), []);
});

test('an unrecognized encrypted vault is not silently overwritten', (t) => {
  const { directory, filePath, vault } = createVault();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const encrypted = vault.safeStorage.encryptString('{"categories": []}').toString('base64');
  const contents = JSON.stringify({ version: 2, encrypted });
  fs.writeFileSync(filePath, contents);
  assert.throws(() => vault.createCategory('QQ'), /file is invalid/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), contents);
});

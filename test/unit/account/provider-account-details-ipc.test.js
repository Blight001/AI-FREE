'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { resolveAppShellViewPath } = require('../../../src/app/backend/config/paths');
const { createIpcRegistry } = require('../../../src/app/backend/ipc/registry');
const { registerProviderAccountDetails } = require('../../../src/app/backend/features/account/register-provider-account-details');

test('provider account detail IPC checks the sender and validates its payloads', async () => {
  const handlers = new Map();
  const registry = createIpcRegistry({ handle: (channel, fn) => handlers.set(channel, fn) });
  const homeUrl = `${pathToFileURL(resolveAppShellViewPath()).href}?dev=0`;
  const frame = { url: homeUrl };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  const trusted = { sender: contents, senderFrame: frame };
  const input = { provider: 'google', id: 'fixture-id' };
  let vaultReads = 0;
  registerProviderAccountDetails(registry, {
    getPassword: () => { vaultReads++; return 'fixture-only'; },
    updateNote: (provider, id, note) => ({ provider, id, note }),
  }, () => contents);
  const reveal = handlers.get('provider-accounts-password');
  const update = handlers.get('provider-accounts-update-note');
  const removeCategory = handlers.get('provider-categories-delete');
  for (const sender of [{ ...trusted, sender: {} }, { ...trusted, senderFrame: { ...frame } }]) {
    assert.equal((await reveal(sender, input)).error.code, 'ACCOUNT_HOME_REQUIRED');
    assert.equal((await update(sender, { ...input, note: '' })).error.code, 'ACCOUNT_HOME_REQUIRED');
    assert.equal((await removeCategory(sender, { provider: 'google' })).error.code, 'ACCOUNT_HOME_REQUIRED');
  }
  frame.url = 'https://example.test/frontend/views/app-shell.html';
  assert.equal((await reveal(trusted, input)).error.code, 'ACCOUNT_HOME_REQUIRED');
  frame.url = 'file:///different/frontend/views/app-shell.html';
  assert.equal((await reveal(trusted, input)).error.code, 'ACCOUNT_HOME_REQUIRED');
  frame.url = homeUrl;
  assert.equal((await reveal(trusted, { ...input, id: 123 })).error.code, 'IPC_INVALID_PAYLOAD');
  assert.equal((await update(trusted, input)).error.code, 'IPC_INVALID_PAYLOAD');
  assert.equal((await update(trusted, { ...input, note: 'x'.repeat(2049) })).error.code, 'IPC_INVALID_PAYLOAD');
  assert.equal((await removeCategory(trusted, {})).error.code, 'IPC_INVALID_PAYLOAD');
  assert.equal(vaultReads, 0);
  assert.deepEqual(await reveal(trusted, input), { ok: true, data: { password: 'fixture-only' } });
  assert.deepEqual(await update(trusted, { ...input, note: '' }), { ok: true, data: { account: { ...input, note: '' } } });
});

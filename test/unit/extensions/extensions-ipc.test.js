'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createIpcRegistry } = require('../../../src/app/backend/ipc/registry');

function createFixture(t, selection) {
  const electronPath = require.resolve('electron');
  const registrarPath = require.resolve('../../../src/app/backend/ipc/register/extensions');
  const owner = {};
  const dialog = t.mock.fn(async () => selection);
  const originalElectron = require.cache[electronPath];
  delete require.cache[registrarPath];
  require.cache[electronPath] = { exports: {
    BrowserWindow: { fromWebContents: () => owner },
    dialog: { showOpenDialog: dialog },
  } };
  const { registerExtensionsIPC } = require(registrarPath);
  t.after(() => {
    delete require.cache[registrarPath];
    if (originalElectron) require.cache[electronPath] = originalElectron;
    else delete require.cache[electronPath];
  });

  const handlers = new Map();
  const ipc = createIpcRegistry({
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: (channel) => handlers.delete(channel),
  });
  t.after(() => ipc.dispose());
  const state = { plugins: [] };
  const importPlugin = t.mock.fn(async () => ({ ok: true, state }));
  registerExtensionsIPC({ ipc, extensionManager: { getPublicState: () => state, importPlugin } });
  return { dialog, importPlugin, owner, state, invoke: (channel) => handlers.get(channel)({ sender: {} }) };
}

test('plugin import opens the directory picker without an account or membership', async (t) => {
  const directory = path.resolve('example-unpacked-extension');
  const fixture = createFixture(t, { canceled: false, filePaths: [directory] });
  const result = await fixture.invoke('import-extension-plugin');
  assert.equal(result.ok, true);
  assert.equal(fixture.dialog.mock.callCount(), 1);
  assert.equal(fixture.dialog.mock.calls[0].arguments[0], fixture.owner);
  assert.deepEqual(fixture.dialog.mock.calls[0].arguments[1].properties, ['openDirectory']);
  assert.equal(fixture.importPlugin.mock.callCount(), 1);
  assert.deepEqual(fixture.importPlugin.mock.calls[0].arguments, [directory]);
  assert.deepEqual(await fixture.invoke('get-extension-manager-state'), {
    ok: true, vipRequired: false, state: fixture.state,
  });
});

test('canceling plugin selection does not import anything', async (t) => {
  const fixture = createFixture(t, { canceled: true, filePaths: [] });
  assert.deepEqual(await fixture.invoke('import-extension-plugin'), {
    ok: false, canceled: true, state: fixture.state,
  });
  assert.equal(fixture.importPlugin.mock.callCount(), 0);
});

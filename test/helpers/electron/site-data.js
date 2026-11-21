'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createIpcRegistry } = require('../../../src/app/backend/ipc/registry');

function bindSiteDataFixture(ipcMain, getMainWindow, runtimeRoot) {
  const backend = path.join(runtimeRoot, 'src/app/backend');
  const { ProfileRuntimeStore } = require(path.join(backend, 'browser-runtime/profile-runtime-store'));
  const { createPreferenceTransfer } = require(path.join(backend, 'features/browser/site-preference-transfer'));
  const { createIndexedDbTransfer } = require(path.join(backend, 'features/browser/indexed-db-transfer'));
  const { createSiteDataHandler } = require(path.join(backend, 'features/browser/site-data-handler'));
  const { listSiteMetadata } = require(path.join(backend, 'platform/site-data-index'));
  const preferences = require(path.join(backend, 'platform/site-preferences'));
  const ipc = createIpcRegistry(ipcMain, { source: 'site-data-fixture' });
  const store = new ProfileRuntimeStore({ rootDir: path.join(process.env.AI_FREE_FIXTURE_ROOT, 'site-fixtures') });
  const source = store.ensureProfile({ profileId: 'shared-browser' });
  const target = store.ensureProfile({ profileId: 'fixture-browser-0' });
  fs.mkdirSync(path.join(target.chromiumData, 'Default'));
  const dir = path.join(source.chromiumData, 'Default');
  fs.mkdirSync(dir, { recursive: true });
  const sound = { 'https://alpha.test:443,*': { setting: 2 }, 'https://beta.test:443,*': { setting: 1 } };
  fs.writeFileSync(path.join(dir, 'Preferences'), JSON.stringify({ profile: { content_settings: { exceptions: { sound } } } }));
  for (const port of [0, 8443]) {
    const databaseDir = path.join(dir, 'IndexedDB', `https_beta.test_${port}.indexeddb.leveldb`);
    fs.mkdirSync(databaseDir, { recursive: true });
    fs.writeFileSync(path.join(databaseDir, 'CURRENT'), 'fixture database');
  }
  const deps = { ui: { browserRuntimeManager: { store }, getMainWindow },
    readHistory: () => [{ id: 'shared-browser' }, { id: 'fixture-browser-0' }], resolveProfileId: (record) => record.id };
  ipc.handle('get-browser-site-data', createSiteDataHandler({ ...deps, listSiteMetadata }));
  ipc.handle('transfer-site-indexed-db', createIndexedDbTransfer(deps));
  ipc.handle('transfer-site-preferences', createPreferenceTransfer({ ...deps, preferences }));
}

module.exports = { bindSiteDataFixture };

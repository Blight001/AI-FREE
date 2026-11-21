'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ProfileRuntimeStore } = require('../../../src/app/backend/browser-runtime/profile-runtime-store');
const { createIndexedDbTransfer } = require('../../../src/app/backend/features/browser/indexed-db-transfer');

const database = 'https_example.test_0.indexeddb.leveldb';
const origin = 'https://example.test';

async function fixture(t) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-free-site-db-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const store = new ProfileRuntimeStore({ rootDir });
  const a = store.ensureProfile({ profileId: 'a' });
  const b = store.ensureProfile({ profileId: 'b' });
  const sourceDb = path.join(a.chromiumData, 'Default', 'IndexedDB', database);
  const targetRoot = path.join(b.chromiumData, 'Default', 'IndexedDB');
  await fs.mkdir(sourceDb, { recursive: true });
  await fs.mkdir(targetRoot, { recursive: true });
  const dataFile = path.join(sourceDb, 'data');
  await fs.writeFile(dataFile, 'source');
  const senderFrame = { url: 'file:///app/frontend/views/app-shell.html' };
  const sender = { mainFrame: senderFrame, isDestroyed: () => false };
  const handler = createIndexedDbTransfer({ ui: { browserRuntimeManager: { store }, getMainWindow: () => ({ webContents: sender }) },
    readHistory: () => [{ id: 'a' }, { id: 'b' }, { id: 'alias-b', profileId: 'b' }], resolveProfileId: (record) => record.profileId || record.id });
  const transfer = (input, event = { sender, senderFrame }) => handler(event, { sourceId: 'a', targetId: 'b', origin, ...input });
  return { store, transfer, dataFile, targetRoot, source: a, target: b };
}

test('rejects stale previews and keeps concurrent launches from interrupting the copy lease', async (t) => {
  const { store, transfer, dataFile, targetRoot, source, target } = await fixture(t);
  const configs = await Promise.all([source, target].map(({ config }) => fs.readFile(config, 'utf8')));
  const preview = await transfer();
  assert.equal(preview.ok, true);
  await fs.writeFile(dataFile, 'updated source');
  assert.equal((await transfer({ revision: preview.data.revision })).error.code, 'SITE_PREVIEW_STALE');
  assert.deepEqual(await fs.readdir(targetRoot), []);
  const current = await transfer();
  const copy = transfer({ revision: current.data.revision });
  assert.throws(() => store.ensureProfile({ profileId: 'b' }), /复制期间/);
  assert.equal(store.releaseLock('b'), false);
  assert.equal((await transfer()).error.code, 'PROFILE_BUSY');
  assert.equal((await copy).ok, true);
  assert.deepEqual(await fs.readdir(targetRoot), [database]);
  assert.equal(await fs.readFile(path.join(targetRoot, database, 'data'), 'utf8'), 'updated source');
  assert.deepEqual(await Promise.all([source, target].map(({ config }) => fs.readFile(config, 'utf8'))), configs);
  assert.equal(store.locks.size, 0);
});

test('requires home sender, canonical origin and distinct profiles', async (t) => {
  const { transfer, targetRoot } = await fixture(t);
  assert.equal((await transfer({}, {})).error.code, 'HOME_REQUIRED');
  assert.equal((await transfer({ origin: 'https://example.test/forbidden-path' })).error.code, 'SITE_ORIGIN_INVALID');
  assert.equal((await transfer({ sourceId: 'alias-b' })).error.code, 'SAME_PROFILE');
  assert.equal((await transfer({ targetId: 'missing' })).error.code, 'HISTORY_NOT_FOUND');
  assert.deepEqual(await fs.readdir(targetRoot), []);
});

test('a retry rolls back blobs from its interrupted copy and preserves the neighboring origin', async (t) => {
  const { transfer, targetRoot } = await fixture(t);
  const { newDatabaseStaging, recordBlobMove } = require('../../../src/app/backend/platform/site-indexed-db-staging');
  const interruptedBlobs = 'https_example.test_0.indexeddb.blob';
  const neighbor = 'https_neighbor.test_0.indexeddb.blob';
  const staging = await newDatabaseStaging(targetRoot);
  await fs.mkdir(path.join(staging, interruptedBlobs));
  await fs.mkdir(path.join(targetRoot, neighbor));
  await recordBlobMove(staging, origin, interruptedBlobs);
  await fs.rename(path.join(staging, interruptedBlobs), path.join(targetRoot, interruptedBlobs));
  const preview = await transfer();
  assert.equal(preview.ok, true);
  assert.deepEqual(await fs.readdir(targetRoot), [neighbor]);
});

test('copies all IndexedDB origins of the selected host with one preview and confirmation', async (t) => {
  const { transfer, source, targetRoot } = await fixture(t);
  const root = path.join(source.chromiumData, 'Default', 'IndexedDB');
  const second = 'https_example.test_8443.indexeddb.leveldb';
  const neighbor = 'https_neighbor.test_0.indexeddb.leveldb';
  for (const name of [second, neighbor]) {
    await fs.mkdir(path.join(root, name));
    await fs.writeFile(path.join(root, name, 'data'), name);
  }
  const site = { origin: undefined, host: 'example.test' };
  const preview = await transfer(site);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.deepEqual(preview.data.origins, [origin, `${origin}:8443`]);
  await fs.mkdir(path.join(targetRoot, second));
  assert.equal((await transfer({ ...site, revision: preview.data.revision })).error.code, 'SITE_DATABASE_CONFLICT');
  assert.deepEqual(await fs.readdir(targetRoot), [second]);
  await fs.rmdir(path.join(targetRoot, second));
  assert.equal((await transfer({ ...site, revision: preview.data.revision })).ok, true);
  assert.deepEqual((await fs.readdir(targetRoot)).sort(), [database, second]);
  assert.equal(await fs.readFile(path.join(root, database, 'data'), 'utf8'), 'source');
});

test('retry removes all published directories of an interrupted batch and keeps other data', async (t) => {
  const { transfer, targetRoot } = await fixture(t);
  const { newDatabaseStaging, recordBatchMoves } = require('../../../src/app/backend/platform/site-indexed-db-staging');
  const second = 'https_example.test_8443.indexeddb.leveldb';
  const neighbor = 'https_neighbor.test_0.indexeddb.leveldb';
  const staging = await newDatabaseStaging(targetRoot);
  const entries = [{ origin, files: [database] }, { origin: `${origin}:8443`, files: [second] }];
  for (const { files: [name] } of entries) await fs.mkdir(path.join(staging, name));
  await fs.mkdir(path.join(targetRoot, neighbor));
  await recordBatchMoves(staging, entries);
  for (const { files: [name] } of entries) await fs.rename(path.join(staging, name), path.join(targetRoot, name));
  assert.equal((await transfer({ origin: undefined, host: 'example.test' })).ok, true);
  assert.deepEqual(await fs.readdir(targetRoot), [neighbor]);
});

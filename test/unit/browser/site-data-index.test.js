'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { listSiteMetadata } = require('../../../src/app/backend/platform/site-data-index');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-sites-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seed(dir, folder, name, sql) {
  const parent = path.join(dir, 'Default', folder);
  fs.mkdirSync(parent, { recursive: true });
  const db = new DatabaseSync(path.join(parent, name));
  try { db.exec(sql); } finally { db.close(); }
}

test('closed profile inventory combines host counts without reading stored values', async (t) => {
  const dir = fixture(t);
  seed(dir, 'Network', 'Cookies', `CREATE TABLE cookies(host_key TEXT);
    INSERT INTO cookies VALUES ('.example.test'), ('example.test')`);
  seed(dir, 'WebStorage', 'QuotaManager', `CREATE TABLE buckets(storage_key TEXT);
    INSERT INTO buckets VALUES ('https://example.test/'), ('https://storage.test/'), ('chrome-extension://internal/')`);
  assert.deepEqual(await listSiteMetadata(dir), { sites: [
    { host: 'example.test', cookies: 2, buckets: 1 }, { host: 'storage.test', cookies: 0, buckets: 1 },
  ], unavailable: [] });
});

test('fresh profile stays empty; unreadable index is reported separately', async (t) => {
  const dir = fixture(t);
  assert.deepEqual(await listSiteMetadata(dir), { sites: [], unavailable: [] });
  assert.deepEqual(fs.readdirSync(dir), []);
  seed(dir, 'Network', 'Cookies', 'CREATE TABLE other(id INTEGER)');
  assert.deepEqual(await listSiteMetadata(dir), { sites: [], unavailable: ['Cookie'] });
});

test('home frame and selected record are required before resolving any profile path', async () => {
  const { createSiteDataHandler } = require('../../../src/app/backend/features/browser/site-data-handler');
  const frame = { url: 'file:///app/frontend/views/app-shell.html' };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  const event = { sender: contents, senderFrame: frame };
  const reads = [];
  const handler = createSiteDataHandler({
    ui: { getMainWindow: () => ({ webContents: contents }), browserRuntimeManager: {
      store: { getProfilePaths: (id) => ({ chromiumData: id }) },
    } },
    readHistory: () => [{ id: 'record-a', profileId: 'profile-a' }],
    resolveProfileId: (record) => record.profileId,
    listSiteMetadata: async (id) => { reads.push(id); return { sites: [], unavailable: [] }; },
  });
  assert.equal((await handler({ ...event, senderFrame: { ...frame } }, { historyId: 'record-a' })).error.code, 'HOME_REQUIRED');
  assert.equal((await handler(event, { historyId: 'missing' })).error.code, 'HISTORY_NOT_FOUND');
  assert.deepEqual(reads, []);
  assert.deepEqual(await handler(event, { historyId: 'record-a' }), { ok: true, data: { sites: [], unavailable: [] } });
  assert.deepEqual(reads, ['profile-a']);
});

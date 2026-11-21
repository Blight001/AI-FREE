'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ProfileRuntimeStore } = require('../../../src/app/backend/browser-runtime/profile-runtime-store');
const { createPreferenceTransfer } = require('../../../src/app/backend/features/browser/site-preference-transfer');
const preferences = require('../../../src/app/backend/platform/site-preferences');

test('import into an existing browser preserves both profile configs, the source and neighboring sites', (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-site-merge-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const store = new ProfileRuntimeStore({ rootDir });
  const selected = 'https://selected.test:443,*';
  const neighbor = 'https://neighbor.test:443,*';
  function seed(id, images) {
    const profile = store.ensureProfile({ profileId: id });
    const config = JSON.stringify({ ...profile.profile, custom: id });
    fs.writeFileSync(profile.config, config);
    const file = path.join(profile.chromiumData, 'Default', 'Preferences');
    fs.mkdirSync(path.dirname(file));
    const content = JSON.stringify({ profile: { content_settings: { exceptions: { images } } } });
    fs.writeFileSync(file, content);
    return { profile, config, file, content };
  }
  const a = seed('a', { [selected]: { setting: 2 }, [neighbor]: { setting: 1 } });
  const b = seed('b', { [neighbor]: { setting: 2 } });
  const frame = { url: 'file:///app/frontend/views/app-shell.html' };
  const sender = { mainFrame: frame, isDestroyed: () => false };
  const event = { sender, senderFrame: frame };
  const transfer = createPreferenceTransfer({ preferences, readHistory: () => [{ id: 'a' }, { id: 'b' }],
    resolveProfileId: record => record.id, ui: { getMainWindow: () => ({ webContents: sender }), browserRuntimeManager: { store } } });
  const request = { sourceId: 'a', targetId: 'b', host: 'selected.test' };
  const preview = transfer(event, request);
  assert.equal(preview.ok, true);
  const apply = () => transfer(event, { ...request, revision: preview.data.revision });
  const holder = new ProfileRuntimeStore({ rootDir });
  holder.acquireLock('b');
  try { assert.equal(apply().error.code, 'PROFILE_UNAVAILABLE'); }
  finally { holder.releaseLock('b'); }
  assert.equal(fs.readFileSync(b.file, 'utf8'), b.content);
  assert.equal(apply().data.verifiedCount, 1);
  assert.equal(fs.readFileSync(a.file, 'utf8'), a.content);
  assert.deepEqual(JSON.parse(fs.readFileSync(b.file)).profile.content_settings.exceptions.images,
    { [neighbor]: { setting: 2 }, [selected]: { setting: 2 } });
  for (const entry of [a, b]) assert.equal(fs.readFileSync(entry.profile.config, 'utf8'), entry.config);
});

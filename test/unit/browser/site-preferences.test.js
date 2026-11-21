'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { previewPreferences, applyPreferences, readPortableRules } = require('../../../src/app/backend/platform/site-preferences');

test('preview and apply migrate only explicit site rules, preserving neighbors and rejecting stale previews', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-pref-test-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const file = (id) => path.join(root, id, 'Default', 'Preferences');
  const key = 'https://example.test:443,*';
  function seed(id, exceptions) {
    fs.mkdirSync(path.dirname(file(id)), { recursive: true });
    fs.writeFileSync(file(id), JSON.stringify({ other: 'keep', profile: { content_settings: { exceptions } } }));
  }
  seed('a', { sound: { [key]: { setting: 2 } }, images: { '[*.]example.test,*': { setting: 2 } }, camera: { [key]: { setting: 1 } } });
  seed('b', { sound: { [key]: { setting: 1 } }, images: { 'https://other.test:443,*': { setting: 1 } } });
  const source = readPortableRules(path.join(root, 'a'));
  assert.equal(source.length, 1);
  const args = [path.join(root, 'b'), source];
  const preview = previewPreferences(...args);
  assert.deepEqual(preview.changes.map(r => [r.kind, r.before, r.after]), [['sound', 1, 2]]);
  assert.throws(() => applyPreferences(...args, 'stale'), { code: 'SITE_PREVIEW_STALE' });
  applyPreferences(...args, preview.revision);
  const result = JSON.parse(fs.readFileSync(file('b')));
  assert.equal(result.profile.content_settings.exceptions.sound[key].setting, 2);
  assert.equal(result.other, 'keep');
  assert.equal(Object.keys(result.profile.content_settings.exceptions.images).length, 1);
  assert.equal(previewPreferences(...args).changes.length, 0);
});

test('a write that leaves the target unchanged never reports a verified import', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-pref-verify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rules = [{ host: 'example.test', kind: 'images', pattern: 'https://example.test:443,*', setting: 2 }];
  const { revision } = previewPreferences(root, rules);
  assert.throws(() => applyPreferences(root, rules, revision, () => {}), { code: 'SITE_PREF_VERIFY_FAILED' });
  const result = applyPreferences(root, rules, revision);
  assert.equal(result.verifiedCount, 1);
});

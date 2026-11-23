'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ProfileRuntimeStore } = require('../../../src/app/backend/browser-runtime/profile-runtime-store');

function temporaryStore(t) {
  const base = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'ai-free-profile-delete-'));
  t.after(() => {
    const target = fs.realpathSync(root);
    assert.equal(path.dirname(target), base);
    fs.rmSync(target, { recursive: true, force: true });
  });
  return new ProfileRuntimeStore({ rootDir: root });
}

test('删除挂起时拒绝同一 Profile 启动与加锁，其他 Profile 仍可读写', async (t) => {
  const store = temporaryStore(t);
  const target = store.ensureProfile({ profileId: 'target' });
  fs.writeFileSync(path.join(target.chromiumData, 'fixture'), 'test');
  const pending = store.deleteProfileAsync('target');
  try {
    assert.throws(() => store.ensureProfile({ profileId: 'target' }), /正在删除/);
    assert.throws(() => store.acquireLock('target'), /正在删除/);
    const other = store.ensureProfile({ profileId: 'other' });
    assert.ok(fs.existsSync(other.config));
    assert.equal(await pending, true);
    assert.equal(fs.existsSync(target.root), false);
    assert.ok(fs.existsSync(other.config));
  } finally {
    await pending;
    store.releaseLock('target');
  }
});

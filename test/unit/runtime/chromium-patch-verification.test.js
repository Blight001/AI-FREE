'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { patchInventory, replayPatches } = require('../../../scripts/verification/patches');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-patch-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'patches');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'series'), 'one.patch\n');
  fs.writeFileSync(path.join(directory, 'one.patch'),
    '--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-before\n+after\n');
  return root;
}

test('patch inventory supports plain unified diffs and reports inactive patches', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'patches/inactive.patch'), 'unused');
  const result = patchInventory(root);
  assert.equal(result.activeCount, 1);
  assert.deepEqual(result.patches[0].files, ['file.txt']);
  assert.deepEqual(result.inactive, ['inactive.patch']);
  assert.equal(result.warnings.length, 1);
  assert.match(result.patches[0].sha256, /^[a-f0-9]{64}$/);
});

test('patch inventory supports Git binary patch headers', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'patches/one.patch'),
    'diff --git a/icon.ico b/icon.ico\nGIT binary patch\nliteral 0\nHcmV?d00001\n');
  assert.deepEqual(patchInventory(root).patches[0].files, ['icon.ico']);
});

test('patch inventory rejects duplicates, missing files and directory traversal', (t) => {
  const root = fixture(t);
  for (const [series, expected] of [
    ['one.patch\none.patch\n', /DUPLICATE_PATCH/],
    ['missing.patch\n', /ENOENT/], ['../outside.patch\n', /INVALID_PATCH_NAME/], ['', /EMPTY_PATCH_SERIES/],
  ]) {
    fs.writeFileSync(path.join(root, 'patches/series'), series);
    assert.throws(() => patchInventory(root), expected);
  }
});

test('isolated patch replay leaves a dirty checkout and its index untouched on success and failure', (t) => {
  const root = fixture(t);
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(source, 'file.txt'), 'before\n');
  git('add', 'file.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline');
  const commit = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'version-lock.json'), JSON.stringify({ chromium: { sourceRoot: source, commit } }));
  fs.writeFileSync(path.join(source, 'file.txt'), 'staged user change\n');
  git('add', 'file.txt');
  fs.writeFileSync(path.join(source, 'file.txt'), 'unstaged user change\n');
  const before = git('diff', 'HEAD');
  const index = fs.readFileSync(path.join(source, '.git/index'));
  const objects = git('count-objects', '-v');
  const first = replayPatches(root, patchInventory(root));
  assert.equal(first.ok, true, JSON.stringify(first));
  fs.writeFileSync(path.join(root, 'patches/one.patch'),
    '--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-does not match\n+after\n');
  const failed = replayPatches(root, patchInventory(root));
  assert.equal(failed.ok, false);
  assert.equal(failed.failedAt, 'one.patch');
  assert.equal(git('diff', 'HEAD'), before);
  assert.deepEqual(fs.readFileSync(path.join(source, '.git/index')), index);
  assert.equal(git('count-objects', '-v'), objects);
  assert.equal(fs.readFileSync(path.join(source, 'file.txt'), 'utf8'), 'unstaged user change\n');
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  buildBrowserEnvironmentExtensionFiles,
  cleanupStaleBrowserEnvironmentExtensions,
  removeBrowserEnvironmentExtension,
  writeBrowserEnvironmentExtension,
} = require('../../../src/app/backend/browser-runtime/chromium-browser-environment-extension');

test('builds a document-start MAIN-world injector and per-profile request header rules', () => {
  const files = buildBrowserEnvironmentExtensionFiles({
    os: 'win11',
    portScanProtection: { enabled: true, allowList: [3000, '5173', 65536, -1] },
  });

  assert.equal(files.manifest.content_scripts[0].run_at, 'document_start');
  assert.equal(files.manifest.content_scripts[0].world, 'MAIN');
  assert.equal(files.manifest.content_scripts[0].all_frames, true);
  assert.deepEqual(files.manifest.declarative_net_request.rule_resources[0], {
    id: 'browser_environment', enabled: true, path: 'rules.json',
  });
  assert.equal(files.rules.some((rule) => rule.action.type === 'modifyHeaders'), false);
  const [allow, block] = files.rules.filter((rule) => rule.action.type !== 'modifyHeaders');
  assert.equal(allow.priority, 2);
  assert.match(allow.condition.regexFilter, /3000\|5173/);
  assert.equal(block.priority, 1);
  assert.match(block.condition.regexFilter, /127/);
});

test('writes and removes only an owned profile-local extension directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-environment-extension-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = writeBrowserEnvironmentExtension(root, { cpu: 8 });

  assert.equal(path.dirname(directory), root);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
    .content_scripts[0].run_at, 'document_start');
  assert.equal(removeBrowserEnvironmentExtension(root, directory), true);
  assert.equal(fs.existsSync(directory), false);
  assert.throws(() => removeBrowserEnvironmentExtension(root, path.join(root, '..')), /目录越界/);
});

test('startup cleanup removes only marked stale generated directories', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-environment-stale-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owned = writeBrowserEnvironmentExtension(root, {});
  const unowned = path.join(root, 'runtime-environment-' + 'a'.repeat(24));
  fs.mkdirSync(unowned);
  fs.writeFileSync(path.join(unowned, 'keep.txt'), 'user file');

  assert.equal(cleanupStaleBrowserEnvironmentExtensions(root), 1);
  assert.equal(fs.existsSync(owned), false);
  assert.equal(fs.existsSync(path.join(unowned, 'keep.txt')), true);
});

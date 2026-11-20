'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const test = require('node:test');

function createPaths(app) {
  const file = require.resolve('../../../src/app/backend/features/account/session-storage-paths');
  const localRequire = createRequire(file);
  const module = { exports: {} };
  const factory = vm.runInThisContext(`(function(require, module) {${fs.readFileSync(file, 'utf8')}\n})`);
  factory((name) => name === 'electron' ? { app } : localRequire(name), module);
  return module.exports.createSessionStoragePaths();
}

function isolateUserDirectory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-session-paths-'));
  const keys = ['APPDATA', 'XDG_CONFIG_HOME', 'ELECTRON_APP_NAME', 'npm_package_name'];
  const saved = keys.map((key) => [key, process.env[key]]);
  process.env.APPDATA = path.join(root, 'roaming');
  process.env.XDG_CONFIG_HOME = path.join(root, 'config');
  process.env.ELECTRON_APP_NAME = 'ai-free';
  process.env.npm_package_name = 'ai-free';
  t.mock.method(os, 'homedir', () => root);
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('sessions retain the explicit Electron userData directory', (t) => {
  const root = isolateUserDirectory(t);
  const official = path.join(root, 'custom-profile');
  const paths = createPaths({ getPath: () => official });
  assert.equal(paths.getSessionsDir(), path.join(official, 'account_sessions'));
  paths.ensureSessionsDir();
  assert.equal(fs.existsSync(paths.getSessionsDir()), true);
});

for (const [name, app] of [
  ['missing Electron app', undefined],
  ['empty userData path', { getPath: () => '' }],
  ['unavailable userData path', { getPath: () => { throw new Error('not ready'); } }],
]) {
  test(`sessions use the system user directory with ${name}`, (t) => {
    const root = isolateUserDirectory(t);
    const base = process.platform === 'win32' ? path.join(root, 'roaming')
      : process.platform === 'darwin' ? path.join(root, 'Library', 'Application Support')
        : path.join(root, 'config');
    const paths = createPaths(app);
    assert.equal(paths.getSessionsDir(), path.join(base, 'ai-free', 'account_sessions'));
    paths.ensureSessionsDir();
    assert.equal(fs.existsSync(paths.getSessionsDir()), true);
  });
}

test('Windows sessions use the home roaming directory when APPDATA is missing', {
  skip: process.platform !== 'win32',
}, (t) => {
  const root = isolateUserDirectory(t);
  delete process.env.APPDATA;
  const paths = createPaths({
    getPath: () => '',
    getName: () => { throw new Error('not ready'); },
  });
  assert.equal(paths.getSessionsDir(), path.join(root, 'AppData', 'Roaming', 'ai-free', 'account_sessions'));
  paths.ensureSessionsDir();
  assert.equal(fs.existsSync(paths.getSessionsDir()), true);
});

test('fallback sessions preserve the Electron application name', (t) => {
  const root = isolateUserDirectory(t);
  const paths = createPaths({ getName: () => 'fixture-app' });
  const base = process.platform === 'win32' ? path.join(root, 'roaming')
    : process.platform === 'darwin' ? path.join(root, 'Library', 'Application Support')
      : path.join(root, 'config');
  assert.equal(paths.getSessionsDir(), path.join(base, 'fixture-app', 'account_sessions'));
});

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { resolveAiSandboxDir } = require('../../../src/app/main/config/paths');

test('AI workspace resolves to the desktop instead of the packaged install directory', () => {
  const exe = path.join('C:\\Program Files', 'AI-FREE', 'AI-FREE.exe');
  const desktop = path.join('C:\\Users', 'tester', 'Desktop');
  const app = { isPackaged: true, getPath: (name) => ({ exe, desktop }[name] || '') };
  assert.equal(resolveAiSandboxDir(app), path.join(desktop, 'AI-Workspace'));
});

test('AI workspace falls back to the source root when desktop is unavailable', () => {
  const project = path.join('D:\\work', 'ai-free');
  const app = { isPackaged: false, getPath: () => '', getAppPath: () => path.join(project, '.generated', 'app') };
  const fakeFs = { existsSync: (candidate) => candidate === path.join(project, 'package.json') };
  assert.equal(resolveAiSandboxDir(app, { fs: fakeFs }), path.join(project, 'AI-Workspace'));
});

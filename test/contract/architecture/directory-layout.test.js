'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..', '..', '..');
const appRoot = path.join(projectRoot, 'src', 'app');

test('应用源码按 backend/frontend/contracts/shared 运行边界组织', () => {
  for (const directory of ['backend', 'frontend', 'contracts', 'shared']) {
    assert.equal(fs.existsSync(path.join(appRoot, directory)), true, `缺少规范目录: ${directory}`);
  }
  for (const legacyDirectory of ['main', 'renderer', 'sidebar', 'views']) {
    assert.equal(fs.existsSync(path.join(appRoot, legacyDirectory)), false, `遗留目录未清理: ${legacyDirectory}`);
  }
});

test('运行入口和页面宿主位于规范目录', () => {
  assert.equal(fs.existsSync(path.join(appRoot, 'backend', 'main.js')), true);
  assert.equal(fs.existsSync(path.join(appRoot, 'frontend', 'views', 'app-shell.html')), true);
  assert.equal(fs.existsSync(path.join(appRoot, 'frontend', 'sidebar', 'ai-control.html')), true);
});

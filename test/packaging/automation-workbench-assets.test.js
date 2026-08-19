'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

const removedAssets = [
  'src/app/renderer/styles/app-shell-automation.css',
  'src/app/renderer/styles/app-shell-automation-canvas.css',
  'src/app/renderer/styles/app-shell-automation-workflow.css',
  'src/app/renderer/controllers/pages/app-shell/automation-canvas-history.js',
  'src/app/renderer/controllers/pages/app-shell/automation-workbench-view-model.js',
  'src/app/renderer/controllers/pages/app-shell/automation-workbench-upgrade.js',
  'src/app/renderer/controllers/pages/app-shell/shell-automation-canvas.js',
  'src/app/renderer/controllers/pages/app-shell/shell-automation-workbench.js',
];

test('homepage no longer ships the native Chromium automation workbench', () => {
  const html = source('src/app/views/app-shell.html');
  for (const token of [
    'automation-workbench', 'automation-workbench-open', 'automation-flow-canvas',
    '原生 Chromium 控制', 'AI 自动化工作台', 'shell-automation-workbench.js',
    'app-shell-automation.css',
  ]) assert.equal(html.includes(token), false, `主窗口仍包含已删除的工作台标记: ${token}`);
});

test('sidebar pages do not reload the removed workbench assets', () => {
  for (const page of ['src/app/sidebar/ai-control.html', 'src/app/sidebar/account-center.html']) {
    const html = source(page);
    assert.equal(html.includes('app-shell-automation'), false, `${page} 仍引用工作台样式`);
    assert.equal(html.includes('shell-automation-'), false, `${page} 仍引用工作台脚本`);
  }
});

test('workbench controller and style files stay deleted until the later rewrite', () => {
  for (const relativePath of removedAssets) {
    assert.equal(fs.existsSync(path.join(root, relativePath)), false, relativePath);
  }
});

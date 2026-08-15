'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('automation workbench packages the workflow UI, history and canvas modules', () => {
  const html = source('src/app/views/app-shell.html');
  for (const id of [
    'automation-tab-cards', 'automation-tab-runs', 'automation-cards-panel',
    'automation-runs-panel', 'automation-card-search', 'automation-card-status-filter',
    'automation-version-list', 'automation-run-list', 'automation-run-dialog',
    'automation-run-target', 'automation-run-input', 'automation-run-step-list',
  ]) assert.match(html, new RegExp(`id=["']${id}["']`), `缺少自动化 UI #${id}`);

  for (const asset of [
    'app-shell-automation-workflow.css', 'automation-canvas-history.js',
    'automation-workbench-view-model.js', 'automation-workbench-upgrade.js',
    'shell-automation-canvas.js', 'shell-automation-workbench.js',
  ]) assert.match(html, new RegExp(asset.replaceAll('.', '\\.')));

  assert.match(html, /data-canvas-add="delay"/);
  assert.match(html, /data-canvas-add="end"/);
  assert.match(html, /data-node-command="start"/);
});

test('sidebar compatibility pages keep the upgraded automation assets loadable', () => {
  for (const page of ['src/app/sidebar/ai-control.html', 'src/app/sidebar/account-center.html']) {
    const html = source(page);
    assert.match(html, /app-shell-automation-workflow\.css/);
    assert.match(html, /automation-canvas-history\.js/);
    assert.match(html, /automation-workbench-view-model\.js/);
    assert.match(html, /automation-workbench-upgrade\.js/);
  }
});

test('automation workbench follows the AI control dark theme and viewport layout', () => {
  const workbenchCss = source('src/app/renderer/styles/app-shell-automation.css');
  const canvasCss = source('src/app/renderer/styles/app-shell-automation-canvas.css');
  const workflowCss = source('src/app/renderer/styles/app-shell-automation-workflow.css');

  assert.match(workbenchCss, /--shell-panel:\s*#0d1420/);
  assert.match(workbenchCss, /--shell-accent:\s*#4d9cff/);
  assert.match(workbenchCss, /color-scheme:\s*dark/);
  assert.match(workbenchCss, /grid-template-columns:\s*228px minmax\(0, 1fr\)/);
  assert.match(workbenchCss, /max-height:\s*calc\(100vh - 184px\)/);
  assert.match(canvasCss, /background-color:\s*#0b1320/);
  assert.match(canvasCss, /height:\s*clamp\(430px, 56vh, 660px\)/);
  assert.match(workflowCss, /background:\s*#3d8bee/);
});

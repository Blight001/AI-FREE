'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('unified extension cards wrap and expose details after the intro line', () => {
  const page = fs.readFileSync(
    path.join(__dirname, '../../../src/app/frontend/views/app-shell.html'),
    'utf8',
  );
  const css = fs.readFileSync(
    path.join(__dirname, '../../../src/app/frontend/renderer/styles/app-shell-extensions.css'),
    'utf8',
  );
  const view = fs.readFileSync(
    path.join(__dirname, '../../../src/app/frontend/renderer/controllers/pages/app-shell/shell-extensions.js'),
    'utf8',
  );
  assert.equal(page.includes('这里启用的插件会安装到全部 AI-FREE 浏览器'), false);
  assert.equal(page.includes('独立浏览器已有的插件不会被修改'), false);
  assert.match(page, /id="extension-manager-title">统一浏览器插件/);
  assert.match(css, /\.extension-plugin-list\s*\{[^}]*flex-wrap:\s*wrap;/s);
  assert.match(css, /\.extension-plugin-item\s*\{[^}]*flex:\s*0 1 220px;/s);
  assert.match(view, /className = 'extension-plugin-summary'/);
  assert.match(view, /button\('详情', 'extension-plugin-details'/);
});

test('browser history reserves a blank page icon so names do not shift when a favicon loads', () => {
  const view = fs.readFileSync(
    path.join(__dirname, '../../../src/app/frontend/sidebar/client/app/side/controllers/pages/side-panel/modules/browser-settings-history-view.js'),
    'utf8',
  );
  const css = fs.readFileSync(
    path.join(__dirname, '../../../src/app/frontend/sidebar/client/app/side/styles/modules/browser-settings.css'),
    'utf8',
  );
  assert.match(view, /className = 'browser-history-icon'/);
  assert.equal(view.includes('icon.remove()'), false);
  assert.match(view, /if \(iconUrl\) image\.src = iconUrl/);
  assert.match(css, /\.browser-history-icon\s*\{[^}]*flex:\s*0 0 22px;/s);
  assert.match(css, /\.browser-history-icon\.has-site-icon img\s*\{/);
});

test('browser settings distinguish the device-memory fingerprint from real memory usage', () => {
  const page = fs.readFileSync(
    path.join(__dirname, '../../../src/app/frontend/views/app-shell.html'),
    'utf8',
  );
  const memoryRow = page.match(/<div class="vb-row"><label[^>]+for="browser-memory"[\s\S]*?<\/div><\/div>/)?.[0] || '';
  assert.match(memoryRow, />设备内存指纹<\/label>/);
  assert.match(memoryRow, /仅影响网页可见的设备信息，不限制浏览器实际内存占用。/);
  const tooltip = fs.readFileSync(
    path.join(__dirname, '../../../src/app/frontend/renderer/controllers/pages/app-shell/tabs-tooltip.js'),
    'utf8',
  );
  assert.match(tooltip, /设备内存指纹：/);
});

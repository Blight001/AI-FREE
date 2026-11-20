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

test('browser tooltip labels legacy preferences and does not report a UA version as the kernel', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(
    path.join(__dirname, '../../../src/app/frontend/renderer/controllers/pages/app-shell/tabs-tooltip.js'),
    'utf8',
  );
  const tooltip = vm.runInNewContext(`${source}\nbuildTabTooltip(tab);`, {
    Intl, URL, tab: {
      title: '测试', browserProfile: { userAgent: 'Chrome/140.0.0.0' },
      browserSettings: { memory: 32, timezone: { mode: 'ip' }, webrtc: { mode: 'block' } },
    },
  });
  assert.match(tooltip, /UA 版本标识：140/);
  assert.doesNotMatch(tooltip, /浏览器内核：AI-FREE Chromium 140/);
  assert.match(tooltip, /WebRTC（旧版记录，未应用）/);
  assert.match(tooltip, /时区：语言地区预设/);
});

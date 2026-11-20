'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

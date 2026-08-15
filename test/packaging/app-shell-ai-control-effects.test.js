'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appShellRoot = path.join(__dirname, '../../src/app/renderer');
const appRoot = path.join(__dirname, '../../src/app');

test('应用外壳不再渲染 AI 浏览器连接粒子或标签高亮', () => {
  const sources = [
    'controllers/pages/app-shell/tabs-renderer.js',
    'controllers/pages/app-shell/tabs-shell-ui.js',
    'styles/app-shell.css',
  ].map((relativePath) => fs.readFileSync(path.join(appShellRoot, relativePath), 'utf8'));

  for (const source of sources) {
    assert.doesNotMatch(source, /ai-browser-connected/);
    assert.doesNotMatch(source, /ai-browser-particle-layer/);
    assert.doesNotMatch(source, /aiBrowserParticleTravel/);
  }
});

test('网络魔法标签效果仍保持独立', () => {
  const css = fs.readFileSync(path.join(appShellRoot, 'styles/app-shell.css'), 'utf8');
  assert.match(css, /\.tab\.network-magic\s*\{/);
  assert.match(css, /@keyframes networkMagicFlow\s*\{/);
});

test('浏览器窗口切换栏作为底部任务栏并使用软件 Logo', () => {
  const html = fs.readFileSync(path.join(appRoot, 'views/app-shell.html'), 'utf8');
  const css = fs.readFileSync(path.join(appShellRoot, 'styles/app-shell.css'), 'utf8');
  const sidebarLayout = fs.readFileSync(path.join(
    appRoot, 'sidebar/client/app/side/styles/modules/layout.css',
  ), 'utf8');
  const tabsController = fs.readFileSync(path.join(
    appShellRoot, 'controllers/pages/app-shell/tabs.js',
  ), 'utf8');

  assert.match(html, /id="add-tab-btn"[^>]*>[\s\S]*?<img[^>]*class="shell-app-logo"[^>]*data-app-logo/);
  assert.doesNotMatch(html, /class="settings-icon"/);
  assert.match(css, /#tab-bar\s*\{[^}]*order:\s*2[^}]*border-top:/s);
  assert.match(css, /#content-area\s*\{[^}]*order:\s*1/s);
  assert.doesNotMatch(sidebarLayout, /transform-origin:\s*top right/);
  assert.match(sidebarLayout, /transform-origin:\s*bottom right/g);
  assert.match(tabsController, /按住向上拖动可选择浏览器历史/);
  assert.match(tabsController, /void createIndependentBrowserFromShell\(\)/);
});

test('底部任务栏提供独立首页入口并在主题按钮左侧显示版本号', () => {
  const html = fs.readFileSync(path.join(appRoot, 'views/app-shell.html'), 'utf8');
  const shellUi = fs.readFileSync(path.join(
    appShellRoot, 'controllers/pages/app-shell/tabs-shell-ui.js',
  ), 'utf8');
  const tabsController = fs.readFileSync(path.join(
    appShellRoot, 'controllers/pages/app-shell/tabs.js',
  ), 'utf8');

  assert.match(html, /id="tabs-container">[\s\S]*?id="home-tab-btn"[\s\S]*?id="new-browser-window-btn"/);
  assert.match(html, /id="home-tab-btn"[\s\S]*?class="home-tab-icon"/);
  assert.match(html, /id="shell-app-version"[\s\S]*?id="theme-toggle-btn"/);
  assert.match(tabsController, /homeTabBtn[\s\S]*?ShellApi\.switchTab\(null\)/);
  assert.match(shellUi, /UpdatesApi\.getAppVersion/);
});

test('个人中心不再显示教程、版本号或资料外层背景盒子', () => {
  const accountHtml = fs.readFileSync(path.join(appRoot, 'sidebar/account-center.html'), 'utf8');
  const themeCss = fs.readFileSync(path.join(
    appRoot, 'sidebar/client/app/side/styles/modules/website-console-theme.css',
  ), 'utf8');

  assert.doesNotMatch(accountHtml, /id="tutorial-link"/);
  assert.doesNotMatch(accountHtml, /id="app-version"/);
  assert.doesNotMatch(accountHtml, /class="footer personal-footer"/);
  assert.match(themeCss, /\.account-center-page \.account-profile-shell,[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none;/);
});

test('个人中心常规设置默认折叠在公告下方且内容宽度自适应', () => {
  const accountHtml = fs.readFileSync(path.join(appRoot, 'sidebar/account-center.html'), 'utf8');
  const accountCss = fs.readFileSync(path.join(
    appRoot, 'sidebar/client/app/side/styles/modules/account-auth.css',
  ), 'utf8');
  const layoutCss = fs.readFileSync(path.join(
    appRoot, 'sidebar/client/app/side/styles/modules/layout.css',
  ), 'utf8');
  const announcementIndex = accountHtml.indexOf('id="announcement-bar"');
  const settingsIndex = accountHtml.indexOf('class="account-general-settings"');

  assert.ok(announcementIndex >= 0 && settingsIndex > announcementIndex);
  assert.match(accountHtml, /<details class="account-general-settings">[\s\S]*?<summary>[\s\S]*?常规设置/);
  assert.doesNotMatch(accountHtml, /<details class="account-general-settings"\s+open/);
  assert.match(accountCss, /\.account-center-panel \.container\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*none;/);
  assert.match(accountCss, /\.account-profile-shell,[\s\S]*?\.account-profile-card\s*\{[\s\S]*?width:\s*100%;/);
  assert.match(accountCss, /\.account-vip-card\s*\{[\s\S]*?max-width:\s*430px;/);
  assert.match(accountCss, /\.sidebar-auth-submit\s*\{[\s\S]*?max-width:\s*430px;/);
  assert.match(layoutCss, /\.sidebar-quota-redeem-row button\s*\{[\s\S]*?flex:\s*0 0 auto;/);
});

test('底部浏览器任务项在文字前装配首个网站图标', () => {
  const renderer = fs.readFileSync(path.join(
    appShellRoot, 'controllers/pages/app-shell/tabs-renderer.js',
  ), 'utf8');
  const css = fs.readFileSync(path.join(appShellRoot, 'styles/app-shell.css'), 'utf8');
  const html = fs.readFileSync(path.join(appRoot, 'views/app-shell.html'), 'utf8');

  assert.match(renderer, /createTabSiteIcon\(tab\)/);
  assert.match(renderer, /tabElement\.appendChild\(createTabSiteIcon\(tab\)\)/);
  assert.match(renderer, /referrerPolicy = 'no-referrer'/);
  assert.match(renderer, /fallbackAttempted/);
  assert.match(renderer, /tab\?\.iconFallbackUrl/);
  assert.match(css, /\.tab-site-icon\s*\{/);
  assert.match(html, /img-src 'self' data: http: https:/);
});

test('浏览器任务项仅在聚焦时显示强调边框且关闭热区足够大', () => {
  const css = fs.readFileSync(path.join(appShellRoot, 'styles/app-shell.css'), 'utf8');

  assert.match(css, /\.tab\s*\{[\s\S]*?background-color:\s*transparent;[\s\S]*?border:\s*1px solid transparent;/);
  assert.match(css, /\.tab\.active\s*\{[\s\S]*?border-width:\s*2px;[\s\S]*?background-color:\s*color-mix/);
  assert.match(css, /\.tab\.network-magic:not\(\.active\)\s*\{[\s\S]*?border-color:\s*transparent;[\s\S]*?background:\s*transparent;/);
  assert.match(css, /\.tab-close\s*\{[\s\S]*?width:\s*26px;[\s\S]*?height:\s*26px;/);
  assert.match(css, /\.tab-close:hover\s*\{[\s\S]*?background:/);
});

test('空白首页使用主进程推送的侧栏像素宽度', () => {
  const homeCss = fs.readFileSync(path.join(appShellRoot, 'styles/app-shell-home.css'), 'utf8');
  const shellUi = fs.readFileSync(path.join(
    appShellRoot, 'controllers/pages/app-shell/tabs-shell-ui.js',
  ), 'utf8');
  const tabsController = fs.readFileSync(path.join(
    appShellRoot, 'controllers/pages/app-shell/tabs.js',
  ), 'utf8');

  assert.match(homeCss, /inset:\s*0\s+var\(--app-shell-sidebar-width,\s*30%\)\s+0\s+0/);
  assert.doesNotMatch(homeCss, /transition:\s*right/);
  assert.doesNotMatch(homeCss, /@media\s*\(max-width:\s*760px\)[\s\S]*?#browser-empty-state/);
  assert.match(shellUi, /--app-shell-sidebar-width/);
  assert.match(tabsController, /onSidebarWidthChanged/);
});

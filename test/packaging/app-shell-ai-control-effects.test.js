'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appShellRoot = path.join(__dirname, '../../src/app/frontend/renderer');
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

test('浏览器窗口切换栏作为底部任务栏并提供个人中心与 AI 控制入口', () => {
  const html = fs.readFileSync(path.join(appRoot, 'frontend/views/app-shell.html'), 'utf8');
  const css = fs.readFileSync(path.join(appShellRoot, 'styles/app-shell.css'), 'utf8');
  const sidebarLayout = fs.readFileSync(path.join(
    appRoot, 'frontend/sidebar/client/app/side/styles/modules/layout.css',
  ), 'utf8');
  const tabsController = fs.readFileSync(path.join(
    appShellRoot, 'controllers/pages/app-shell/tabs.js',
  ), 'utf8');

  assert.match(html, /id="shell-network-magic-toggle"[^>]*class="shell-action-btn[^"]*"[\s\S]*?内置代理/);
  assert.match(html, /id="theme-toggle-btn"[\s\S]*?id="shell-network-magic"[\s\S]*?id="add-tab-btn"/);
  assert.match(html, /id="add-tab-btn"[^>]*class="shell-action-btn[^"]*"[\s\S]*?个人中心/);
  assert.match(html, /id="shell-ai-control-btn"[^>]*class="shell-action-btn[^"]*"[\s\S]*?AI 控制/);
  assert.match(html, /id="add-tab-btn"[\s\S]*?class="shell-action-icon"[\s\S]*?id="shell-ai-control-btn"[\s\S]*?class="shell-action-icon"/);
  assert.match(css, /\.shell-action-icon\s*\{[\s\S]*?border:\s*0/);
  assert.match(css, /\.shell-action-btn\s*\{[\s\S]*?background:\s*rgba\(77, 163, 255, 0\.16\)/);
  assert.match(css, /\.shell-theme-toggle-btn\s*\{[\s\S]*?background:\s*rgba\(77, 163, 255, 0\.16\)/);
  assert.doesNotMatch(html, /class="settings-icon"/);
  assert.match(css, /--app-ui-font:\s*Inter, "Segoe UI", "Microsoft YaHei", sans-serif/);
  assert.match(css, /font-family:\s*var\(--app-ui-font/);
  assert.match(sidebarLayout, /font-family:\s*var\(--app-ui-font/);
  assert.match(css, /#tab-bar\s*\{[^}]*order:\s*2[^}]*border-top:/s);
  assert.match(css, /#content-area\s*\{[^}]*order:\s*1/s);
  assert.doesNotMatch(sidebarLayout, /transform-origin:\s*top right/);
  assert.match(sidebarLayout, /transform-origin:\s*bottom right/g);
  assert.match(tabsController, /按住向上拖动可选择浏览器历史/);
  assert.match(tabsController, /void createIndependentBrowserFromShell\(\)/);
  assert.match(tabsController, /UiApi\.openAccountCenterSidebar\?\.\(\)/);
  assert.doesNotMatch(tabsController, /ShellApi\.openAccountCenterSidebar/);
});

test('底部任务栏提供独立首页入口并在主题按钮左侧显示版本号', () => {
  const html = fs.readFileSync(path.join(appRoot, 'frontend/views/app-shell.html'), 'utf8');
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

test('内置代理收进底部任务栏魔法棒，首页空白页不再展示开关', () => {
  const html = fs.readFileSync(path.join(appRoot, 'frontend/views/app-shell.html'), 'utf8');
  const popupHtml = fs.readFileSync(path.join(appRoot, 'frontend/views/network-magic-popup.html'), 'utf8');
  const sidebarHtml = fs.readFileSync(path.join(appRoot, 'frontend/sidebar/ai-control.html'), 'utf8');
  const controller = fs.readFileSync(path.join(
    appShellRoot, 'controllers/pages/app-shell/shell-network-magic.js',
  ), 'utf8');
  const popupController = fs.readFileSync(path.join(
    appRoot, 'backend/features/network/network-magic-popup-controller.js',
  ), 'utf8');
  const sidebarCss = fs.readFileSync(path.join(
    appRoot, 'frontend/sidebar/client/app/side/styles/modules/network-magic-sidebar.css',
  ), 'utf8');
  const emptyState = html.match(/id="browser-empty-state"[\s\S]*?<\/main>/)?.[0] || '';

  assert.match(html, /id="shell-app-version"[\s\S]*?id="theme-toggle-btn"[\s\S]*?id="shell-network-magic"/);
  assert.match(html, /id="shell-network-magic-toggle"[\s\S]*?class="network-magic-wand-icon"/);
  assert.match(popupHtml, /id="network-magic-sidebar-dialog"[\s\S]*?id="VPN-switch"[\s\S]*?开启魔法代理/);
  assert.match(popupHtml, /id="vpn-node-selector-toggle-btn"[\s\S]*?切换节点/);
  assert.match(popupHtml, /id="vpn-node-selector-panel"[\s\S]*?class="vpn-node-selector-dialog"/);
  assert.doesNotMatch(html, /id="network-magic-sidebar-dialog"/);
  assert.doesNotMatch(html, /id="VPN-switch"/);
  assert.doesNotMatch(sidebarHtml, /id="network-magic-sidebar-dialog"/);
  assert.doesNotMatch(sidebarHtml, /id="VPN-switch"/);
  assert.doesNotMatch(emptyState, /id="VPN-switch"/);
  assert.doesNotMatch(emptyState, /内置代理/);
  assert.doesNotMatch(emptyState, /vpn-node-selector-toggle-btn/);
  assert.match(sidebarCss, /\.network-magic-sidebar-dialog\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0;/);
  assert.match(sidebarCss, /html\.network-magic-popup-page \.vpn-node-selector-dialog\s*\{[\s\S]*?position:\s*relative;/);
  assert.match(controller, /toggleNetworkMagicPanel/);
  assert.match(controller, /readNetworkMagicButtonAnchor/);
  assert.doesNotMatch(controller, /openAiControlSidebar/);
  assert.match(popupController, /alwaysOnTop:\s*true/);
  assert.match(popupController, /setAlwaysOnTop\(true, 'pop-up-menu'\)/);
});

test('个人中心不再显示教程、版本号或资料外层背景盒子', () => {
  const accountHtml = fs.readFileSync(path.join(appRoot, 'frontend/sidebar/account-center.html'), 'utf8');
  const themeCss = fs.readFileSync(path.join(
    appRoot, 'frontend/sidebar/client/app/side/styles/modules/website-console-theme.css',
  ), 'utf8');

  assert.doesNotMatch(accountHtml, /id="tutorial-link"/);
  assert.doesNotMatch(accountHtml, /id="app-version"/);
  assert.doesNotMatch(accountHtml, /class="footer personal-footer"/);
  assert.match(themeCss, /\.account-center-page \.account-profile-shell,[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none;/);
});

test('个人中心常规设置默认折叠在公告下方且内容宽度自适应', () => {
  const accountHtml = fs.readFileSync(path.join(appRoot, 'frontend/sidebar/account-center.html'), 'utf8');
  const accountCss = fs.readFileSync(path.join(
    appRoot, 'frontend/sidebar/client/app/side/styles/modules/account-auth.css',
  ), 'utf8');
  const layoutCss = fs.readFileSync(path.join(
    appRoot, 'frontend/sidebar/client/app/side/styles/modules/layout.css',
  ), 'utf8');
  const sidebarNavigationCss = fs.readFileSync(path.join(
    appRoot, 'frontend/sidebar/client/app/side/styles/modules/sidebar-navigation.css',
  ), 'utf8');
  const uiScaleJs = fs.readFileSync(path.join(
    appRoot, 'frontend/sidebar/client/scripts/ui-scale.js',
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
  assert.match(accountHtml, /id="ui-scale"[^>]*type="range"[^>]*min="100"[^>]*max="120"/);
  assert.match(accountHtml, /id="ui-scale"[^>]*value="110"/);
  assert.doesNotMatch(accountHtml, /ui-scale-value|>110%<|>100%</);
  assert.match(accountHtml, /界面大小[\s\S]*?id="ui-scale-hint-pop"[^>]*>调整字体、控件和底部任务栏的显示大小。</);
  assert.match(accountHtml, /开机启动[\s\S]*?id="app-startup-hint-pop"[^>]*>登录 Windows 后自动启动。关闭方式为后台时隐藏到系统托盘；询问或退出时正常打开窗口。</);
  assert.doesNotMatch(accountHtml, /<p>调整字体、控件和底部任务栏的显示大小。<\/p>/);
  assert.doesNotMatch(accountHtml, /<p>登录 Windows 后自动启动，并隐藏到系统托盘。<\/p>/);
  assert.match(accountCss, /\.account-pref-hint-pop\s*\{/);
  assert.match(accountCss, /\.account-pref-hint-wrap:hover \.account-pref-hint-pop/);
  assert.match(accountCss, /\.account-ui-scale-control\s*\{/);
  assert.match(uiScaleJs, /const DEFAULT = 1\.1/);
  assert.doesNotMatch(layoutCss, /zoom:\s*var\(--ui-scale/);
  assert.match(layoutCss, /html\s*\{[^}]*height:\s*100%;/s);
  assert.match(layoutCss, /body\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;/s);
  assert.match(sidebarNavigationCss, /\.control-shell\s*\{[\s\S]*?width:\s*calc\(100% \/ var\(--ui-scale,\s*1\)\)/);
  assert.match(sidebarNavigationCss, /\.control-shell\s*\{[\s\S]*?transform:\s*scale\(var\(--ui-scale,\s*1\)\)/);
  assert.match(sidebarNavigationCss, /\.control-shell\s*\{[\s\S]*?transform-origin:\s*top left/);
  assert.doesNotMatch(accountHtml, /sidebar-bottom-actions|data-open-ai-control|data-open-account-center/);
  assert.doesNotMatch(accountHtml, /external-codex|account-codex-bridge|copy-external-codex-config/);
  assert.match(layoutCss, /\.sidebar-quota-redeem-row button\s*\{[\s\S]*?flex:\s*0 0 auto;/);
});

test('外部 Codex 放在添加自定义模型弹窗栏目而不是常规设置', () => {
  const aiHtml = fs.readFileSync(path.join(appRoot, 'frontend/sidebar/ai-control.html'), 'utf8');
  const accountHtml = fs.readFileSync(path.join(appRoot, 'frontend/sidebar/account-center.html'), 'utf8');
  const css = fs.readFileSync(path.join(
    appRoot, 'frontend/sidebar/client/app/side/styles/modules/ai-control.css',
  ), 'utf8');
  const preference = fs.readFileSync(path.join(
    appRoot, 'frontend/sidebar/client/app/side/controllers/pages/side-panel/modules/external-codex-preference.js',
  ), 'utf8');

  assert.doesNotMatch(accountHtml, /id="external-codex-status"|id="copy-external-codex-config"|外部 Codex/);
  assert.match(aiHtml, /id="ai-custom-api-dialog"[\s\S]*?data-ai-config-page="codex">外部 Codex/);
  assert.match(aiHtml, /id="ai-external-codex-panel"[\s\S]*?安装 Codex 插件/);
  assert.match(aiHtml, /粘贴给 Codex/);
  assert.match(aiHtml, /id="copy-external-codex-config"[^>]*>复制给 Codex/);
  assert.match(aiHtml, /external-codex-preference\.js/);
  assert.match(css, /\.ai-external-codex-steps\s*\{/);
  assert.match(preference, /refreshExternalCodexPreference/);
  assert.match(preference, /\(function bindExternalCodexPreferenceModule\(\)/);
  assert.doesNotMatch(preference, /^function setStatus\(/m);
});

test('底部浏览器任务项在文字前装配首个网站图标', () => {
  const renderer = fs.readFileSync(path.join(
    appShellRoot, 'controllers/pages/app-shell/tabs-renderer.js',
  ), 'utf8');
  const css = fs.readFileSync(path.join(appShellRoot, 'styles/app-shell.css'), 'utf8');
  const html = fs.readFileSync(path.join(appRoot, 'frontend/views/app-shell.html'), 'utf8');

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

  assert.match(homeCss, /width:\s*calc\(\(100% - var\(--app-shell-sidebar-width,\s*30%\)\) \/ var\(--ui-scale,\s*1\)\)/);
  assert.match(homeCss, /transform:\s*scale\(var\(--ui-scale,\s*1\)\)/);
  assert.match(homeCss, /transform-origin:\s*top left/);
  assert.match(homeCss, /#browser-empty-state::before[\s\S]*?background-image:\s*url\("\.\.\/\.\.\/\.\.\/\.\.\/assets\/background\.png"\)/);
  assert.match(homeCss, /html:not\(\.theme-light\) #browser-empty-state::before[\s\S]*?filter:\s*brightness\(0\.48\)/);
  assert.doesNotMatch(homeCss, /transition:\s*right/);
  assert.doesNotMatch(homeCss, /@media\s*\(max-width:\s*760px\)[\s\S]*?#browser-empty-state/);
  assert.match(shellUi, /--app-shell-sidebar-width/);
  assert.match(tabsController, /onSidebarWidthChanged/);
});

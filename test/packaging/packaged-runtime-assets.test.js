const { readAiControlSource } = require('../helpers/source-bundles');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { resolveLogoUrl } = require('../../src/app/shared/app-assets');

const packageJson = require('../../package.json');
const { resolveBindingCandidates } = require('../../src/app/backend/browser-runtime/chromium-window-bridge');
const { assertStaticVCRuntime } = require('../../scripts/verify-packaged-runtime');

test('packaged native browser host resolves from external resources first', () => {
  const resourcesPath = path.resolve('C:/AI-FREE/resources');
  const appRoot = path.join(resourcesPath, 'app.asar');
  const candidates = resolveBindingCandidates({ resourcesPath, appRoot });

  assert.equal(
    candidates[0],
    path.join(resourcesPath, 'native', 'browser-host', 'browser_host.node'),
  );
  assert.ok(candidates.indexOf(path.join(appRoot, 'native', 'browser-host', 'build', 'Release', 'browser_host.node')) > 0);
});

test('staged development app resolves the native browser host from the project root', () => {
  const projectRoot = path.resolve('D:/workspace/ai-free');
  const appRoot = path.join(projectRoot, '.generated', 'app');
  const candidates = resolveBindingCandidates({
    appRoot,
    resourcesPath: path.join(projectRoot, 'node_modules', 'electron', 'dist', 'resources'),
    workingDirectory: projectRoot,
  });

  assert.ok(candidates.includes(
    path.join(projectRoot, 'native', 'browser-host', 'build', 'Release', 'browser_host.node'),
  ));
});

test('native host and runtime logo are packaged only as external resources', () => {
  const files = packageJson.build.files || [];
  const extraResources = packageJson.build.extraResources || [];

  assert.equal(files.includes('native/browser-host/build/Release/browser_host.node'), false);
  assert.ok(files.includes('!src/assets/logo.ico'));
  assert.ok(extraResources.some((entry) => (
    entry.from === 'native/browser-host/build/Release/browser_host.node'
      && entry.to === 'native/browser-host/browser_host.node'
  )));
  assert.ok(extraResources.some((entry) => (
    entry.from === 'src/assets/logo.ico' && entry.to === 'resource/logo.ico'
  )));
});

test('native host has no external VC++ redistributable dependency', () => {
  assert.doesNotThrow(() => assertStaticVCRuntime(
    path.join(__dirname, '../../native/browser-host/build/Release/browser_host.node'),
  ));
  assert.match(packageJson.scripts.build, /build:native-host/);
  assert.match(packageJson.scripts['build:portable'], /build:native-host/);
});

test('sidebar logos use the runtime asset resolver in source and packaged apps', () => {
  const sidebarRoot = path.join(__dirname, '../../src/app/frontend/sidebar');
  const index = fs.readFileSync(path.join(sidebarRoot, 'index.html'), 'utf8');
  const aiControlPage = fs.readFileSync(path.join(sidebarRoot, 'ai-control.html'), 'utf8');
  assert.equal(fs.existsSync(path.join(sidebarRoot, 'account-center.html')), false);
  const appShell = fs.readFileSync(path.join(__dirname, '../../src/app/frontend/views/app-shell.html'), 'utf8');
  const layoutCss = fs.readFileSync(
    path.join(sidebarRoot, 'client/app/side/styles/modules/layout.css'),
    'utf8',
  );
  const logoResolver = fs.readFileSync(
    path.join(__dirname, '../../src/app/frontend/sidebar/client/scripts/logo-assets.js'),
    'utf8',
  );
  const aiControl = readAiControlSource();

  assert.ok(index.includes("location.replace('./ai-control.html')"));
  for (const html of [aiControlPage]) {
    assert.ok(html.includes('<script src="./client/scripts/logo-assets.js"></script>'));
  }
  assert.equal((aiControlPage.match(/<img[^>]*data-app-logo/g) || []).length, 1);
  assert.ok(logoResolver.includes('AiFreeAppAssets.resolveLogoUrl'));
  for (const html of [aiControlPage, appShell]) {
    assert.ok(html.includes('<script src="../../shared/app-assets.js"></script>'));
  }
  assert.ok(aiControl.includes('window.aiFreeLogoAssets.url'));
  assert.equal(appShell.includes('id="account-center-btn"'), false);
  assert.equal(fs.existsSync(path.join(sidebarRoot, '../../backend/views/dev-console.html')), false);
  assert.doesNotMatch(aiControlPage, /id="home-console/);
  assert.match(appShell, /id="home-console-tab"[^>]*hidden/);
  assert.match(appShell, /id="home-mcp-tab"[^>]*hidden/);
  assert.doesNotMatch(aiControlPage, /id="(?:home-mcp|ai-chat-browser(?:-trigger)?|ai-chat-target|ai-prompt-diagnostics-dialog)/);
  for (const file of ['styles/app-shell-console.css', 'controllers/pages/app-shell/shell-home-console.js',
    'styles/app-shell-flow-studio.css', 'controllers/pages/app-shell/automation-canvas.js',
    'controllers/pages/app-shell/shell-home-automation.js',
    'controllers/pages/app-shell/site-preference-transfer.js',
    'styles/app-shell-site-data.css', 'controllers/pages/app-shell/site-data.js',
    'controllers/pages/app-shell/home-dialogs.js',
    'styles/app-shell-mcp.css', 'controllers/pages/app-shell/shell-home-mcp.js']) {
    const relative = `../renderer/${file}`;
    assert.ok(appShell.includes(`"${relative}"`));
    assert.ok(fs.statSync(path.resolve(sidebarRoot, relative)).size > 0);
  }
  assert.ok(appShell.includes('../sidebar/client/scripts/logo-assets.js'));
  assert.ok(appShell.includes('app-shell-network-magic.css'));
  assert.ok(appShell.includes('shell-network-magic.js'));
  assert.ok(appShell.includes('id="shell-network-magic-toggle"'));
  const networkMagicPopup = fs.readFileSync(path.join(sidebarRoot, '../views/network-magic-popup.html'), 'utf8');
  assert.ok(networkMagicPopup.includes('id="network-magic-sidebar-dialog"'));
  assert.ok(networkMagicPopup.includes('id="vpn-node-selector-panel"'));
  assert.equal(appShell.includes('id="network-magic-sidebar-dialog"'), false);
  assert.equal(aiControlPage.includes('id="network-magic-sidebar-dialog"'), false);
  assert.equal(aiControlPage.includes('network-magic-sidebar.js'), false);
  assert.equal(aiControlPage.includes('id="vpn-node-selector-panel"'), false);
  assert.equal(appShell.includes('settings-network-tools-proxy-title'), false);
  assert.equal((appShell.match(/<img[^>]*data-app-logo/g) || []).length, 2);
  assert.match(appShell, /id="home-personal"[\s\S]*?id="sidebar-account-auth"/);
  assert.doesNotMatch(appShell, /id="add-tab-btn"/);
  assert.match(appShell, /id="shell-ai-control-btn"[\s\S]*?AI 控制/);
  assert.ok(appShell.includes('id="ai-free-settings-panel"'));
  assert.ok(appShell.includes('id="browser-settings-tutorial"'));
  assert.equal(appShell.includes('id="automation-workbench"'), false);
  assert.equal(appShell.includes('automation-workbench-open'), false);
  assert.equal(appShell.includes('shell-automation-canvas.js'), false);
  assert.equal(appShell.includes('shell-automation-workbench.js'), false);
  assert.equal(appShell.includes('app-shell-automation-canvas.css'), false);
  assert.ok(appShell.includes('id="home-automation-tab"'));
  assert.ok(appShell.includes('id="home-automation"'));
  assert.match(layoutCss, /#browser-empty-state::\-webkit-scrollbar-thumb/);
});

test('runtime logo URLs resolve from both frontend page hosts to the source asset', () => {
  const logoPath = path.resolve(__dirname, '../../src/assets/logo.ico');
  for (const pageDirectory of ['sidebar', 'views']) {
    assert.equal(
      fileURLToPath(resolveLogoUrl(pathToFileURL(path.resolve(
        __dirname, '../../src/app/frontend', pageDirectory, 'page.html',
      )).href)),
      logoPath,
    );
  }
});

test('embedded Chromium clears hover tooltips when hidden or deactivated', () => {
  const focusManager = fs.readFileSync(path.join(
    __dirname, '../../native/browser-host/src/focus_manager.cc',
  ), 'utf8');
  const hostWindow = fs.readFileSync(path.join(
    __dirname, '../../native/browser-host/src/browser_host_window.cc',
  ), 'utf8');
  const shellWindow = fs.readFileSync(path.join(
    __dirname, '../../src/app/backend/services/app-shell-main-window.js',
  ), 'utf8');

  assert.match(focusManager, /DismissBrowserTransientUi\(child\)/);
  assert.match(focusManager, /WM_MOUSELEAVE/);
  assert.match(focusManager, /ShowWindowAsync\(hwnd, SW_HIDE\)/);
  assert.match(hostWindow, /HideHostWindow[\s\S]*?DismissBrowserTransientUi/);
  assert.match(shellWindow, /mainWindow\.on\('blur',[\s\S]*?dismissActiveBrowserTransientUi/);
});

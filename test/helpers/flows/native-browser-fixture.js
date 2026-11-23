'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { createResourceScope } = require('./resources');
const { createBrowserRuntimeManager } = require('../../../src/app/backend/browser-runtime');
const { createNativeBrowserAutomation } = require('../../../src/app/backend/services/native-browser-automation');
const workflow = require('../../acceptance/scripts/native-browser-workflow-scenarios');

function fixturePage(url) {
  const pathname = new URL(url, 'http://127.0.0.1').pathname;
  if (pathname === '/workflow') return workflow.html;
  const framePage = workflow.framePage(pathname);
  if (framePage) return framePage;
  if (pathname === '/one') return `<button id="go" onclick="document.title='CLICKED';
    this.dataset.state=String(event.isTrusted);document.querySelector('#click-count').textContent++">click</button>
    <output id="click-count">0</output><input id="name"><input id="secret" type="password" value="must-not-leak">
    <label><input id="yes" type="checkbox" checked>yes</label><label><input id="no" type="checkbox">no</label><a href="/two">two</a>`;
  if (pathname === '/two') return '<title>TWO</title><p>second</p>';
  return '<title>ALIGN_READY</title><button id="go">ready</button>';
}

function nativeBrowserFixture(BrowserWindow, options = {}) {
  const scope = createResourceScope();
  // electron-process owns this directory and removes it after Electron exits.
  if (!process.env.AI_FREE_FIXTURE_ROOT) throw new Error('FIXTURE_PROCESS_REQUIRED');
  const root = fs.mkdtempSync(path.join(process.env.AI_FREE_FIXTURE_ROOT, 'native-browser-'));
  return {
    close: () => scope.close(),
    async start() {
      const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<!doctype html>${fixturePage(req.url)}`);
      });
      scope.defer('server', async () => {
        if (!server.listening) return;
        const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        server.closeAllConnections();
        await closed;
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const origin = `http://127.0.0.1:${server.address().port}`;
      const shell = new BrowserWindow({ show: true, width: 900, height: 700, webPreferences: options.webPreferences });
      scope.defer('window', () => { if (!shell.isDestroyed()) shell.destroy(); });
      await shell.loadURL('data:text/html,<body>Native browser alignment acceptance</body>');
      const manager = createBrowserRuntimeManager({
        userDataDir: root, sandboxDir: path.join(root, 'AI-Workspace'),
        resourcesPath: options.resourcesPath || process.env.AI_FREE_ACCEPTANCE_RESOURCES_PATH || path.resolve(__dirname, '../../../resources'),
        getParentWindow: () => shell, logger: console,
      });
      scope.defer('runtime', async () => {
        const results = await manager.stopAll({ timeoutMs: 5000 });
        if (results.some((result) => result?.success === false || result?.ok === false)) throw new Error('RUNTIME_STOP_FAILED');
      });
      await manager.launchProfile({ profileId: 'alignment', runtimeType: 'chromium', initialUrl: 'about:blank',
        launchTimeoutMs: 30000, extraArgs: options.extraArgs }, { x: 0, y: 0, width: 900, height: 700 });
      const automation = createNativeBrowserAutomation({ browserRuntimeManager: manager,
        getTabs: () => new Map([['alignment', { id: 'alignment', fixedTitle: 'Alignment Chromium' }]]) });
      return { automation, id: 'native:alignment', origin, manager, shell };
    },
  };
}

module.exports = { nativeBrowserFixture };

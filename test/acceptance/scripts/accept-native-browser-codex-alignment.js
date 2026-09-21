'use strict';

// Small, isolated acceptance probe for the NativeBrowserAutomation contract.
// It deliberately uses a temporary Chromium profile and a loopback page.
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { once } = require('node:events');
const { app, BrowserWindow } = require('electron');
const { createBrowserRuntimeManager } = require('../../../src/app/backend/browser-runtime');
const { createNativeBrowserAutomation } = require('../../../src/app/backend/services/native-browser-automation');
const workflow = require('./native-browser-workflow-scenarios');

const chromiumPath = String(process.env.AI_FREE_ACCEPTANCE_CHROMIUM_PATH || '').trim();
if (chromiumPath) {
  process.env.AI_FREE_CHROMIUM_HANDSHAKE = 'prototype';
  process.env.AI_FREE_CHROMIUM_PATH = chromiumPath;
} else {
  delete process.env.AI_FREE_CHROMIUM_HANDSHAKE;
  delete process.env.AI_FREE_CHROMIUM_PATH;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-codex-align-'));
let manager; let server; let shell;

function page(url) {
  const p = new URL(url).pathname;
  if (p === '/workflow') return workflow.html;
  if (p === '/one') return '<button id="go" onclick="document.title=\'CLICKED\'">click</button><input id="name"><input id="secret" type="password" value="must-not-leak"><label><input id="yes" type="checkbox" checked>yes</label><label><input id="no" type="checkbox">no</label><a href="/two">two</a>';
  if (p === '/two') return '<title>TWO</title><p>second</p>';
  return '<title>ALIGN_READY</title><button id="go">ready</button>';
}

async function main() {
  server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(`<!doctype html>${page(`http://127.0.0.1${req.url}`)}`); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  shell = new BrowserWindow({ show: true, width: 900, height: 700 });
  await shell.loadURL('data:text/html,<body>Native browser alignment acceptance</body>');
  manager = createBrowserRuntimeManager({
    userDataDir: root, sandboxDir: path.join(root, 'AI-Workspace'),
    resourcesPath: process.env.AI_FREE_ACCEPTANCE_RESOURCES_PATH || path.resolve(__dirname, '..', '..', '..', 'resources'),
    getParentWindow: () => shell, logger: console,
  });
  await manager.launchProfile({ profileId: 'alignment', runtimeType: 'chromium', initialUrl: 'about:blank', launchTimeoutMs: 30000 }, { x: 0, y: 0, width: 900, height: 700 });
  const getTabs = () => new Map([['alignment', { id: 'alignment', fixedTitle: 'Alignment Chromium' }]]);
  const automation = createNativeBrowserAutomation({ browserRuntimeManager: manager, getTabs });
  const id = 'native:alignment';
  const call = (tool, input) => automation.dispatch(id, tool, input);

  const acquire = async () => {
    const result = await call('browser_control', { action: 'acquire' });
    assert.equal(result.success, true, `Chromium takeover failed: ${JSON.stringify(result)}`);
  };

  await acquire();
  const first = await call('browser_tab', { action: 'navigate', url: `${origin}/one` });
  assert.equal(first.success, true);
  await acquire();
  const listed = await call('browser_tab', { action: 'list' });
  assert.ok(listed.activeTab || listed.tabs?.length);
  const ready = await call('browser_wait', { condition: 'visible', selector: '#secret', timeout_ms: 10000 });
  assert.equal(ready.success, true, JSON.stringify(ready));
  assert(!JSON.stringify(ready).includes('must-not-leak'));
  const observed = await call('browser_observe', { limit: 20, mark: false, include_accessibility_tree: true, include_screenshot: true });
  assert.equal(observed.accessibilityTree?.format, 'ax-tree-v1');
  assert(Array.isArray(observed.accessibilityTree.nodes));
  const leakedFields = [];
  const scan = (value, prefix) => {
    if (typeof value === 'string' && value.includes('must-not-leak')) leakedFields.push(prefix);
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key, child]) => scan(child, `${prefix}.${key}`));
  };
  scan(observed, 'observation');
  assert.deepEqual(leakedFields, [], 'password must not leak through DOM or AX');
  const checkboxes = observed.accessibilityTree.nodes.filter((node) => node.role === 'checkBox');
  assert(checkboxes.some((node) => node.states.checked === true));
  assert(checkboxes.some((node) => node.states.checked === false));
  assert(typeof observed.dataUrl === 'string' && observed.dataUrl.startsWith('data:image/png'));
  assert.equal(observed.screenshot?.format, 'png');
  const password = observed.items.find((item) => item.selector === '#secret');
  assert(password && password.value !== 'must-not-leak' && password.text !== 'must-not-leak');
  assert.equal(observed.items.find((item) => item.selector === '#yes')?.checked, true);
  assert.equal(observed.items.find((item) => item.selector === '#no')?.checked, false);
  const button = observed.items.find((item) => item.selector === '#go');
  assert.ok(button, 'button must be observable');
  const clickedAction = await call('browser_action', { action: 'click', ref: button.id, observation_id: observed.observationId, after: 'observe', observation_options: { include_accessibility_tree: true, include_screenshot: true } });
  assert.equal(clickedAction.actionExecuted, true);
  assert(clickedAction.observation?.observationId);
  const clicked = await call('browser_observe', { keyword: 'CLICKED', limit: 10, mark: false });
  assert.equal(clicked.title, 'CLICKED');
  const textInput = await call('browser_observe', { filter: 'input', limit: 10, mark: false });
  const input = textInput.items.find((item) => item.selector === '#name');
  assert.ok(input);
  await call('browser_action', { action: 'type', ref: input.id, observation_id: textInput.observationId, text: 'Codex' });
  const edited = await call('browser_observe', { filter: 'input', limit: 10, mark: false });
  assert.equal(edited.items.find((item) => item.selector === '#name')?.value, 'Codex');
  await call('browser_tab', { action: 'replace', url: `${origin}/two` });
  await acquire();
  assert.equal((await call('browser_tab', { action: 'back' })).success, true);
  await acquire();
  assert.equal((await call('browser_wait', { condition: 'url_matches', value: '/one', timeout_ms: 5000 })).success, true);
  assert.equal((await call('browser_tab', { action: 'forward' })).success, true);
  await acquire();
  assert.equal((await call('browser_wait', { condition: 'url_matches', value: '/two', timeout_ms: 5000 })).success, true);
  const stale = await call('browser_action', { action: 'click', ref: input.id, observation_id: textInput.observationId });
  assert(['OBSERVATION_MISMATCH', 'OBSERVED_REF_EXPIRED'].includes(stale.errorCode));
  const tabs = await call('browser_tab', { action: 'list' });
  const target = tabs.activeTab?.id || tabs.tabs?.[0]?.id;
  if (tabs.tabs?.length > 1) {
    const other = tabs.tabs.find((tab) => String(tab.id) !== String(target));
    assert.equal((await call('browser_tab', { action: 'switch', tab_id: Number(other.id) })).success, true);
    await acquire();
  }
  assert.equal((await call('browser_tab', { action: 'close', tab_id: Number(target) })).success, true);
  assert.equal((await call('browser_tab', { action: 'list' })).tabs.length, tabs.tabs.length - 1);
  console.log('[native-codex-alignment] tab lifecycle, trusted click/edit, and stale-ref rejection passed');
  await workflow.run(automation, id, origin);
}

async function cleanup(exitCode) {
  try { await manager?.stopAll({ timeoutMs: 5000 }); } catch (_) {}
  try { if (server?.listening) await new Promise((resolve) => server.close(resolve)); } catch (_) {}
  try { shell?.destroy(); } catch (_) {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  app.exit(exitCode);
}

app.whenReady().then(main).then(async () => {
  await cleanup(0);
}).catch(async (error) => {
  console.error('[native-codex-alignment] FAILED', error.stack || error);
  await cleanup(1);
});

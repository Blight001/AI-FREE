'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { BrowserWindow, ipcMain } = require('electron');
const { createIpcRegistry } = require('../../../src/app/backend/ipc/registry');
const { poll, rendererProbe } = require('../../helpers/flows/electron-controls');

async function launchPanel({ shell, automation, manager, panelAppRoot }) {
  const backend = path.join(panelAppRoot, 'src/app/backend');
  const { resolveMcpDebugWindowPaths, resolveAppShellViewPath } = require(path.join(backend, 'config/paths'));
  const { registerMcpDebugPanelIpc } = require(path.join(backend, 'features/browser/register-mcp-debug-panel-ipc'));
  const ipc = createIpcRegistry(ipcMain);
  let ownerClosed = false;
  let benchmarkStarted = false;
  const bridge = {
    listConnections: () => automation.listConnections(),
    getConnection: (id) => automation.getConnection(id),
    dispatch: (...args) => automation.dispatch(...args),
    listBrowserRecords: () => [{ tabId: 'alignment' }],
  };
  const dispose = registerMcpDebugPanelIpc(ipc, {
    isDevMode: true, getMainWindow: () => shell, BrowserWindow,
    browserAutomationBridge: bridge, browserRuntimeManager: manager,
    benchmark: { start: async () => { benchmarkStarted = true; return { sent: true }; } },
    getWindowTools: () => ({ tools: [] }),
  });
  const sender = shell.webContents;
  shell.once('closed', () => { ownerClosed = true; });
  try {
    const open = () => sender.executeJavaScript('window.aiFree.diagnostics.openMcpDebugPanel()');
    assert.equal((await open()).ok, false, 'non-home sender must be rejected');
    await shell.loadFile(resolveAppShellViewPath(), { query: { dev: '1' } });
    await sender.executeJavaScript(`document.getElementById('home-mcp-tab').click();
      document.getElementById('home-mcp-debug').click()`);
    const panel = await poll(() => BrowserWindow.getAllWindows().find((win) => win.isVisible()
      && win.webContents.getURL().endsWith('mcp-debug-panel.html')), Boolean);
    assert(panel && panel.isVisible(), `panel opened with its own window: ${resolveMcpDebugWindowPaths().view}`);
    return { panel, dispose, ownerClosed: () => ownerClosed, benchmarkStarted: () => benchmarkStarted };
  } catch (error) {
    dispose();
    throw error;
  }
}

async function checkNativeInputs({ panel, shell, automation, id }) {
  const inspect = rendererProbe(panel.webContents);
  const opened = await inspect(() => window.aiFree.mcpDebug.openFixture());
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const bound = automation.requireConnection(id);
  const ready = await poll(() => automation.runtimeCommand(bound, 'observe-page', { mode: 'overview', showHighlights: false }),
    (value) => value.title?.includes('鼠标调试测试页'));
  assert.equal(ready.success, true);
  assert.match(ready.title, /鼠标调试测试页/);
  await automation.runtimeCommand(bound, 'activate-tab', { index: 0 });
  shell.minimize();
  assert(panel.isVisible() && !panel.isMinimized(), 'panel stays visible after owner minimizes');
  panel.focus();
  await poll(() => panel.isFocused(), Boolean);
  await startPanel(panel, 'fixture');
  const takeover = await poll(() => automation.runtimeCommand(bound, 'automation-takeover', { action: 'status' }),
    (value) => value.takeoverActive && value.pointerVisible);
  assert.equal(takeover.takeoverActive, true, 'native takeover is active while the preview is running');
  assert.equal(takeover.pointerVisible, true, 'Chromium enabled its native pointer overlay');
  const extent = (await automation.runtimeCommand(bound, 'observe-page', { mode: 'overview', showHighlights: false })).viewport;
  await checkFixtureGestures({ panel, automation, bound, extent });
}

async function startPanel(panel, mode) {
  const inspect = rendererProbe(panel.webContents);
  await inspect((targetMode) => {
    document.getElementById('target-mode').value = targetMode;
    document.getElementById('toggle').click();
  }, mode);
  const rendered = await poll(() => inspect(() => ({ loaded: document.getElementById('frame').naturalWidth > 0,
    status: document.getElementById('status').textContent })), (value) => value.loaded || /失败|不可用|不支持/.test(value.status));
  assert.equal(rendered.loaded, true, JSON.stringify(rendered));
}

async function previewPoint(panel, automation, connection, extent, selector, offsetX = 0) {
  const { target } = await automation.runtimeCommand(connection, 'inspect-page-state', { target: { selector } });
  assert.equal(target.count, 1, selector);
  return rendererProbe(panel.webContents)((x, y, width, height) => {
    const frame = document.getElementById('frame');
    const box = frame.getBoundingClientRect();
    const scale = Math.min(box.width / frame.naturalWidth, box.height / frame.naturalHeight);
    const imageWidth = frame.naturalWidth * scale;
    const imageHeight = frame.naturalHeight * scale;
    return { x: Math.round(box.x + (box.width - imageWidth) / 2 + x * imageWidth / width),
      y: Math.round(box.y + (box.height - imageHeight) / 2 + y * imageHeight / height) };
  }, target.clickX + offsetX, target.clickY, extent.width, extent.height);
}

function clickPreview(panel, point, button = 'left') {
  panel.webContents.sendInputEvent({ ...point, type: 'mouseMove' });
  for (const type of ['mouseDown', 'mouseUp']) panel.webContents.sendInputEvent({ ...point, type, button, clickCount: 1 });
}

async function checkFixtureGestures({ panel, automation, bound, extent }) {
  const inspect = rendererProbe(panel.webContents);
  const mappedPoint = (selector, offsetX) => previewPoint(panel, automation, bound, extent, selector, offsetX);
  const send = (input) => panel.webContents.sendInputEvent(input);
  const click = (point, button) => clickPreview(panel, point, button);
  const read = () => automation.runtimeCommand(bound, 'inspect-page-state', { probes: [{ selector: '#events', name: 'events', read: 'text' }] });
  const evidence = async (pattern) => {
    const reply = await poll(read, (value) => pattern.test(value.values?.events?.value || ''));
    assert.match(reply.values.events.value, pattern);
  };
  const firstFrame = await inspect(() => document.getElementById('frame').src);
  click(await mappedPoint('#check'), 'left');
  await evidence(/click · check.+trusted=true/);
  await evidence(/change · check/);
  const pointer = await inspect(() => ({ visible: !document.getElementById('cursor').hidden,
    mapped: document.getElementById('mapped').textContent }));
  assert.equal(pointer.visible, true, 'panel pointer is visible after a mouse move over the fixture');
  assert.match(pointer.mapped, /^\d+, \d+$/);
  const refreshed = await poll(() => inspect(() => document.getElementById('frame').src), (src) => src !== firstFrame);
  assert.notEqual(refreshed, firstFrame, 'preview follows the fixture while the owner is minimized');
  panel.setSize(850, 680);
  click(await mappedPoint('#click-target'), 'right');
  await evidence(/contextmenu · click-target.+trusted=true/);
  await inspect(() => { document.getElementById('double-click').checked = true; });
  click(await mappedPoint('#click-target'), 'left');
  await evidence(/dblclick · click-target.+trusted=true/);
  await inspect(() => { document.getElementById('double-click').checked = false; });
  click(await mappedPoint('#frame-check'), 'left');
  await evidence(/change · frame-check/);
  const scroll = await mappedPoint('#scroll-target');
  send({ ...scroll, type: 'mouseWheel', deltaX: 0, deltaY: -116 });
  await evidence(/wheel · .+trusted=true/);
  const from = await mappedPoint('#drag-target');
  const to = await mappedPoint('#drag-target', 45);
  send({ ...from, type: 'mouseMove' });
  send({ ...from, type: 'mouseDown', button: 'left', clickCount: 1 });
  send({ ...to, type: 'mouseMove', modifiers: ['leftButtonDown'] });
  send({ ...to, type: 'mouseUp', button: 'left', clickCount: 1 });
  await evidence(/pointermove · .+buttons=1.+trusted=true/);
  await evidence(/pointerup · .+btn=0.+trusted=true/);
  assert.notDeepEqual(await mappedPoint('#drag-target'), from, 'live drag changes the knob position');
}

async function checkTabChangeReleases(panel, automation, browser, status) {
  panel.focus();
  assert(await poll(() => panel.isFocused(), Boolean));
  const inspect = rendererProbe(panel.webContents);
  await inspect(() => document.getElementById('toggle').click());
  assert(await poll(() => inspect(() => document.getElementById('frame').naturalWidth > 0), Boolean));
  await automation.runtimeCommand(browser, 'activate-tab', { index: 0 });
  assert(await poll(async () => (await status()).takeoverActive === false, Boolean), 'tab change releases takeover');
}

async function checkWebsite({ panel, automation, id, origin, debugHost, manager }) {
  const address = new URL('/one', origin);
  address.hostname = debugHost;
  const { href: url } = address;
  const opened = await manager.openForegroundTab('alignment', 'chromium', url);
  assert.equal((opened.result || opened).url, url);
  const browser = automation.requireConnection(id);
  const ready = await poll(() => automation.dispatch(id, 'browser_tab', { action: 'list' }),
    (result) => result.activeTab?.url === url && Boolean(result.activeTab?.pageToken));
  assert.equal(ready.activeTab?.url, url);
  assert(ready.activeTab?.pageToken, 'local page has a committed document token');
  panel.focus();
  assert(await poll(() => panel.isFocused(), Boolean));
  await startPanel(panel, 'active');
  const inspect = rendererProbe(panel.webContents);
  assert.equal(await inspect(() => document.getElementById('target-url').textContent), url);
  const observation = await automation.dispatch(id, 'browser_observe', { mode: 'overview', mark: false });
  clickPreview(panel, await previewPoint(panel, automation, browser, observation.viewport, '#go'));
  const receipt = await poll(() => inspect(() => document.getElementById('receipt').textContent),
    (value) => value === 'browser_action · click');
  assert.equal(receipt, 'browser_action · click');
  const result = await automation.runtimeCommand(browser, 'inspect-page-state', { probes: [
    { selector: '#go', name: 'trusted', read: 'attribute', attribute: 'data-state' },
    { selector: '#click-count', name: 'count', read: 'text' },
  ] });
  assert.equal(result.values.trusted.value, 'true');
  assert.equal(result.values.count.value, '1');
}

async function checkMcpDebugPanel(context) {
  const { shell, automation, id, manager } = context;
  const { panel, dispose, ownerClosed, benchmarkStarted } = await launchPanel(context);
  try {
    const inspect = rendererProbe(panel.webContents);
    assert.deepEqual(await inspect(() => ({ start: Boolean(document.getElementById('benchmark-start')),
      model: Boolean(document.getElementById('benchmark-model')), score: Boolean(document.getElementById('benchmark-score')),
      restart: Boolean(document.getElementById('restart-app')), autoRestart: Boolean(document.getElementById('auto-restart')) })),
    { start: true, model: false, score: false, restart: true, autoRestart: true },
    'panel exposes a launcher and dev restart controls; model choice and score remain in the AI conversation');
    await inspect(() => document.getElementById('benchmark-start').click());
    assert(await poll(benchmarkStarted, Boolean), 'launcher hands off the run to the shared benchmark controller');
    assert.equal(await inspect(() => document.getElementById('benchmark-status').textContent),
      '已发送，请在 AI 控制对话中查看进度和成绩。');
    await checkNativeInputs({ ...context, panel });
    shell.restore();
    shell.focus();
    const browser = automation.requireConnection(id);
    const status = () => automation.runtimeCommand(browser, 'automation-takeover', { action: 'status' });
    const takeover = await poll(status, (value) => value.takeoverActive === false);
    assert.equal(takeover.takeoverActive, false, 'blur releases takeover');
    assert.equal(takeover.pointerVisible, false, 'blur hides the native pointer overlay');
    await checkTabChangeReleases(panel, automation, browser, status);
    assert(await poll(() => rendererProbe(panel.webContents)(() => document.getElementById('frame').hidden), Boolean));
    await checkWebsite({ ...context, panel });
    await manager.stopAll({ timeoutMs: 5000 });
    shell.close();
    assert(await poll(ownerClosed, Boolean), 'owner closed');
    assert(await poll(() => panel.isDestroyed(), Boolean), 'panel closes with owner');
    console.log('[mcp-debug-panel] shared MCP click, drag, wheel, website tab, focus and window lifetime verified');
  } finally { dispose(); }
}

module.exports = { checkMcpDebugPanel };

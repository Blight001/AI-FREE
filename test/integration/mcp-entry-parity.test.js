'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createBrowserAutomationBridge } = require('../../src/app/backend/services/browser-automation-bridge');
const { normalizeToolSchema } = require('../../src/app/backend/services/automation-tool-contract');
const { createAiChatService } = require('../../src/app/backend/features/ai-chat/ai-chat-service');
const { buildChatToolContext } = require('../../src/app/backend/features/ai-chat/chat-tool-context');
const { dispatchPluginTool } = require('../../src/app/backend/features/ai-chat/chat-tool-executor');
const { CONFIRMED_UPLOAD_FILES } = require('../../src/app/backend/browser-runtime/chromium-upload-staging');

const URL = 'http://127.0.0.1/fixture';
const PAGE = 'fixture-page-token';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVbcAAAAASUVORK5CYII=', 'base64');
const SHA256 = crypto.createHash('sha256').update(PNG).digest('hex');
const SHARED_TOOLS = [
  'account_manage', 'browser_action', 'browser_control', 'browser_environment', 'browser_file', 'browser_media',
  'browser_observe', 'browser_screenshot', 'browser_tab', 'browser_wait', 'manage_card', 'run_command', 'windows_tab',
];

function runtimeFixture(workspace) {
  const page = { id: '0', title: 'Fixture', url: URL, pageToken: PAGE };
  const observations = [{ id: 'e1', tag: 'img', selector: '#reference', kind: 'media', width: 40, height: 40, x: 5, y: 5 }];
  const selections = [];
  const actions = [];
  const replies = {
    'list-tabs': { activeTab: page, tabs: [page], activeTabId: '0' },
    'observe-page': { url: URL, items: observations },
    'inspect-page-state': { url: URL, values: {}, target: { found: true, count: 1, visible: true, selector: '#reference' } },
    'inspect-page-diagnostics': { cursor: 0, events: [] },
    'automation-takeover': { takeoverActive: true },
    'get-session-data': { url: URL },
    'download-element': { resourceUrl: 'http://127.0.0.1/reference.png' },
    'capture-screenshot': { dataUrl: `data:image/png;base64,${PNG.toString('base64')}` },
  };
  return {
    selections, actions,
    runtime: {
      listStates: () => [{ profileId: 'fixture', pid: 42, bridgeConnected: true, status: 'ready' }],
      async dispatchAutomationByProcessId(_pid, command, args, options) {
        if (command === 'perform-action') {
          actions.push({ args, token: options?.expectedPageToken });
          return { result: { success: true, action: args.action,
            ...(args.action === 'wait' ? { condition: args.condition, found: true } : { dispatched: true }),
            ...(args.selectionId ? { fileSelected: true } : {}),
          } };
        }
        assert.ok(replies[command], `Unexpected Chromium command ${command}`);
        return { result: { success: true, ...replies[command] } };
      },
      async selectFilesByProcessId(_pid, args, options) {
        assert.deepEqual(args.paths, [path.join(workspace, 'reference.png')]);
        selections.push({ files: args[CONFIRMED_UPLOAD_FILES], token: options?.expectedPageToken });
        return { result: { success: true, selectionId: 'fixture-selection' } };
      },
    },
  };
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aifree-mcp-parity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const chromium = runtimeFixture(workspace);
  const file = path.join(workspace, 'reference.png');
  const bridge = createBrowserAutomationBridge({ workspaceDir: workspace, cardCacheDir: root,
    browserRuntimeManager: chromium.runtime, getExternalMcpAccess: () => true,
    browserDownloadService: {
      resolveUploadPaths: (paths) => paths.map((candidate) => path.resolve(workspace, candidate)),
      async downloadElement(_args, trigger) {
        const result = await trigger(file);
        assert.equal(result.success, true);
        fs.writeFileSync(file, PNG);
        return { success: true, action: 'download_element', relative_path: 'reference.png', sha256: SHA256, size: PNG.length };
      },
    },
  });
  const chat = createAiChatService({ aiSandboxDir: workspace, browserWindowUi: { getTabs: () => [] }, providerAccountVault: {} });
  const windowTools = chat.getWindowTools();
  assert.ok(windowTools);
  bridge.configureExternalMcp({ getWindowTools: chat.getWindowTools });
  const connections = bridge.listConnections().map(({ id }) => bridge.getConnection(id));
  return { workspace, ...chromium, bridge, windowTools, connections };
}

function sidebarTools({ connections, windowTools }, content) {
  return buildChatToolContext({ connections, windowTools, localInteraction: true,
    initialMessages: [{ role: 'user', content }] }).tools;
}

function comparableSchema(tool) {
  const schema = normalizeToolSchema(tool);
  if (schema.properties.change_browser) {
    const { description: _description, ...route } = schema.properties.change_browser;
    schema.properties.change_browser = route;
  }
  return schema;
}

test('connected sidebar and external MCP catalogs share parameter contracts and enumerate entry-specific tools', (t) => {
  const fixture = createFixture(t);
  const external = fixture.bridge.listExternalMcpTools().tools;
  const sidebar = sidebarTools(fixture, '检查浏览器环境配置');
  assert.deepEqual(external.map(({ name }) => name).sort(), [...SHARED_TOOLS, 'browser_workflow'].sort());
  assert.deepEqual(sidebar.map(({ name }) => name).sort(), [...SHARED_TOOLS, 'browser_page_batch'].sort());
  for (const name of SHARED_TOOLS) {
    assert.deepEqual(comparableSchema(sidebar.find((tool) => tool.name === name)),
      comparableSchema(external.find((tool) => tool.name === name)), name);
  }
  assert.equal(sidebarTools(fixture, '读取网页正文').some(({ name }) => name === 'browser_environment'), false);
});

function toolEntries({ bridge, workspace, connections }) {
  const context = { bridge, connections, localInteraction: true, workspaceDir: workspace, browserTargets: new Map(),
    describeConnections: () => 'Fixture', waitForAbort: async (value) => value };
  return {
    sidebar: (name, args) => dispatchPluginTool(context, name, args),
    external: (name, args) => bridge.callExternalMcpTool(name, args),
  };
}

test('both MCP entries can read tabs, observe media, wait, capture PNG and operate after takeover', async (t) => {
  const fixture = createFixture(t);
  const { external, sidebar } = toolEntries(fixture);
  for (const call of [external, sidebar]) {
    const tabs = await call('browser_tab', { action: 'list' });
    assert.equal(tabs.activeTab.url, URL);
    const media = await call('browser_media', { action: 'list' });
    assert.equal(media.media[0].ref, 'e1');
    const waited = await call('browser_wait', { condition: 'attached', selector: '#reference' });
    assert.equal(waited.success, true);
    const screenshot = await call('browser_screenshot', {});
    assert.equal(screenshot.dataUrl, `data:image/png;base64,${PNG.toString('base64')}`);
    assert.equal((await call('browser_control', { action: 'acquire' })).success, true);
    const clicked = await call('browser_action', { action: 'click', selector: '#reference', timeout_ms: 200 });
    assert.equal(clicked.success, true, JSON.stringify(clicked));
  }
  assert.equal(fixture.actions.filter(({ args }) => args.action === 'click').length, 2);
  assert.equal(fixture.actions.at(-1).token, PAGE);
});

test('both MCP entries send the same PNG to a supported control and sidebar keeps document and byte guards', async (t) => {
  const fixture = createFixture(t);
  const { external, sidebar } = toolEntries(fixture);
  for (const call of [external, sidebar]) {
    assert.equal((await call('browser_control', { action: 'acquire' })).success, true);
    assert.equal((await call('browser_observe', { filter: 'media' })).items[0].selector, '#reference');
    const download = await call('browser_file', { action: 'download_element', ref: 'e1' });
    assert.equal(download.sha256, SHA256);
    const upload = await call('browser_file', { action: 'upload', path: download.relative_path, selector: '#file' });
    assert.equal(upload.success, true);
    if (call === sidebar) assert.equal(upload.uploadVerification, 'file_selected');
  }
  assert.equal(fixture.selections.length, 2);
  assert.equal(fixture.selections[1].token, PAGE);
  assert.equal(fixture.selections[1].files[0].sha256, SHA256);
  assert.equal(fixture.actions[1].token, PAGE);
  assert.equal(fixture.actions[1].args.selectionId, 'fixture-selection');
});

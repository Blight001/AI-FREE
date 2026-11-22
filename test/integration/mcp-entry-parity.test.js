'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createBrowserAutomationBridge } = require('../../src/app/backend/services/browser-automation-bridge');
const { createBrowserDownloadService } = require('../../src/app/backend/services/browser-download-service');
const { normalizeToolSchema } = require('../../src/app/backend/services/automation-tool-contract');
const { createAiChatService } = require('../../src/app/backend/features/ai-chat/ai-chat-service');
const { ProviderAccountVault } = require('../../src/app/backend/features/account/provider-account-vault');
const { buildChatToolContext } = require('../../src/app/backend/features/ai-chat/chat-tool-context');
const { dispatchPluginTool, executeSingleTool } = require('../../src/app/backend/features/ai-chat/chat-tool-executor');
const { CONFIRMED_UPLOAD_FILES } = require('../../src/app/backend/browser-runtime/chromium-upload-staging');

const URL = 'http://127.0.0.1/fixture';
const PAGE = 'fixture-page-token';
const SESSION = { url: URL, cookies: [], localStorage: { environment: 'fixture-only-value' }, sessionStorage: {} };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVbcAAAAASUVORK5CYII=', 'base64');
const SHA256 = crypto.createHash('sha256').update(PNG).digest('hex');
const SHARED_TOOLS = [
  'account_manage', 'browser_action', 'browser_control', 'browser_environment', 'browser_file', 'browser_media',
  'browser_observe', 'browser_page_batch', 'browser_screenshot', 'browser_tab', 'browser_wait',
  'browser_workflow', 'manage_card', 'run_command', 'windows_tab',
];

function runtimeFixture(workspace, { afterAction, sessionFailure }) {
  const page = { id: '0', title: 'Fixture', url: URL, pageToken: PAGE };
  const observations = [{ id: 'e1', tag: 'img', selector: '#reference', kind: 'media', width: 40, height: 40, x: 5, y: 5 }];
  const selections = [];
  const actions = [];
  const commands = [];
  const replies = {
    'list-tabs': { activeTab: page, tabs: [page], activeTabId: '0' },
    'observe-page': { url: URL, items: observations },
    'inspect-page-state': { url: URL, values: {}, target: { found: true, count: 1, visible: true, selector: '#reference' } },
    'inspect-page-diagnostics': { cursor: 0, events: [] },
    'automation-takeover': { takeoverActive: true },
    'get-session-data': SESSION,
    'download-element': { resourceUrl: 'http://127.0.0.1/reference.png' },
    'capture-screenshot': { dataUrl: `data:image/png;base64,${PNG.toString('base64')}` },
  };
  return {
    selections, actions, commands,
    runtime: {
      listStates: () => [{ profileId: 'fixture', pid: 42, bridgeConnected: true, status: 'ready' }],
      async dispatchAutomationByProcessId(_pid, command, args, options) {
        commands.push({ command, args, token: options?.expectedPageToken });
        if (command === 'perform-action') {
          actions.push({ args, token: options?.expectedPageToken });
          afterAction?.(args);
          return { result: { success: true, action: args.action,
            ...(args.action === 'wait' ? { condition: args.condition, found: true } : { dispatched: true }),
            ...(args.selectionId ? { fileSelected: true } : {}),
          } };
        }
        if (command === 'get-session-data' && sessionFailure) {
          throw Object.assign(new Error('页面已切换'), { code: sessionFailure });
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

function createFixture(t, { connected = true, afterAction, sessionFailure, vault = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aifree-mcp-parity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const chromium = runtimeFixture(workspace, { afterAction, sessionFailure });
  const file = path.join(workspace, 'reference.png');
  const bridge = createBrowserAutomationBridge({ workspaceDir: workspace, cardCacheDir: root,
    browserRuntimeManager: connected ? chromium.runtime : undefined, getExternalMcpAccess: () => true,
    browserDownloadService: {
      ...createBrowserDownloadService({ sandboxDir: workspace }),
      resolveUploadPaths: (paths) => paths.map((candidate) => path.resolve(workspace, candidate)),
      async downloadElement(_args, trigger) {
        const result = await trigger(file);
        assert.equal(result.success, true);
        fs.writeFileSync(file, PNG);
        return { success: true, action: 'download_element', relative_path: 'reference.png', sha256: SHA256, size: PNG.length };
      },
    },
  });
  const chat = createAiChatService({ aiSandboxDir: workspace, browserWindowUi: { getTabs: () => [] },
    providerAccountVault: vault, getMainWindow: () => null });
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

test('connected sidebar and external MCP enumerate the same tools and parameter contracts', (t) => {
  const fixture = createFixture(t);
  const external = fixture.bridge.listExternalMcpTools().tools;
  const sidebar = sidebarTools(fixture, '检查浏览器环境配置');
  assert.deepEqual(external.map(({ name }) => name).sort(), [...SHARED_TOOLS].sort());
  assert.deepEqual(sidebar.map(({ name }) => name).sort(), [...SHARED_TOOLS].sort());
  for (const name of SHARED_TOOLS) {
    assert.deepEqual(comparableSchema(sidebar.find((tool) => tool.name === name)),
      comparableSchema(external.find((tool) => tool.name === name)), name);
  }
  assert.equal(sidebarTools(fixture, '读取网页正文').some(({ name }) => name === 'browser_environment'), false);
});

function toolEntries({ bridge, workspace, connections }, signal) {
  const context = { bridge, connections, localInteraction: true, workspaceDir: workspace, browserTargets: new Map(),
    signal, describeConnections: () => 'Fixture', waitForAbort: async (value) => value };
  return {
    sidebar: (name, args) => dispatchPluginTool(context, name, args),
    external: (name, args) => bridge.callExternalMcpTool(name, args, signal),
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
    const clicked = await call('browser_action', { action: 'click', selector: '#reference', timeout_ms: 200, after: 'observe' });
    assert.equal(clicked.success, true, JSON.stringify(clicked));
    assert.equal(clicked.actionExecuted, true);
    assert.equal(clicked.observation.items[0].selector, '#reference');
  }
  assert.equal(fixture.actions.filter(({ args }) => args.action === 'click').length, 2);
  assert.deepEqual(fixture.actions.filter(({ args }) => args.action === 'click').map(({ token }) => token), [PAGE, PAGE]);
  assert.deepEqual(fixture.commands.filter(({ command, args }) => command === 'capture-screenshot' && !args.width)
    .map(({ token }) => token), [PAGE, PAGE]);
  assert.deepEqual(fixture.actions.filter(({ args }) => args.action === 'wait').map(({ token }) => token), [PAGE, PAGE]);
});

test('both MCP entries send the same PNG to a supported control and sidebar keeps document and byte guards', async (t) => {
  const fixture = createFixture(t);
  const { external, sidebar } = toolEntries(fixture);
  for (const call of [external, sidebar]) {
    assert.equal((await call('browser_control', { action: 'acquire' })).success, true);
    assert.equal((await call('browser_observe', { filter: 'media' })).items[0].selector, '#reference');
    const download = await call('browser_file', { action: 'download_element', ref: 'e1' });
    assert.equal(download.sha256, SHA256);
    assert.equal(download.pageClickDispatched, false);
    const upload = await call('browser_file', { action: 'upload', path: download.relative_path, selector: '#file' });
    assert.equal(upload.success, true);
    assert.equal(upload.uploadVerification, 'file_selected');
    assert.match(upload.message, /页面回执/);
  }
  assert.equal(fixture.selections.length, 2);
  assert.deepEqual(fixture.selections.map(({ token }) => token), [PAGE, PAGE]);
  assert.equal(fixture.selections[1].files[0].sha256, SHA256);
  assert.equal(fixture.actions[1].token, PAGE);
  assert.deepEqual(fixture.actions.map(({ args }) => args.selectionId), ['fixture-selection', 'fixture-selection']);
});


test('both MCP entries export the bound session locally and return only file metadata', async (t) => {
  const fixture = createFixture(t);
  for (const [entry, call] of Object.entries(toolEntries(fixture))) {
    const receipt = await call('browser_file', { action: 'save_session', filename: 'evalpilot-settings-session.json', directory: entry });
    assert.equal(receipt.success, true, JSON.stringify(receipt));
    assert.equal(receipt.file_name, 'evalpilot-settings-session.json');
    assert.equal(receipt.cookie_count, 0);
    assert.equal(receipt.absolute_path, path.join(fixture.workspace, entry, receipt.file_name));
    assert.deepEqual(JSON.parse(fs.readFileSync(receipt.absolute_path, 'utf8')), { success: true, ...SESSION });
    assert.doesNotMatch(JSON.stringify(receipt), /fixture-only-value/);
  }
  assert.deepEqual(fixture.commands.filter(({ command }) => command === 'get-session-data')
    .map(({ token }) => token), [PAGE, PAGE]);
});

test('both MCP entries refuse session export after a document change and write no file', async (t) => {
  const fixture = createFixture(t, { sessionFailure: 'BROWSER_TARGET_CHANGED' });
  for (const [entry, call] of Object.entries(toolEntries(fixture))) {
    const result = await call('browser_file', { action: 'save_session', filename: 'wrong-page.json', directory: entry });
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'BROWSER_TARGET_CHANGED');
    assert.equal(result.retryable, false);
    assert.equal(fs.existsSync(path.join(fixture.workspace, entry)), false);
  }
});

test('interleaved observations retain distinct reference ownership at each entry', async (t) => {
  const fixture = createFixture(t);
  const { external, sidebar } = toolEntries(fixture);
  assert.equal((await external('browser_control', { action: 'acquire' })).success, true);
  const outer = await external('browser_observe', { filter: 'media' });
  const inner = await sidebar('browser_observe', { filter: 'media' });
  assert.notEqual(outer.observationId, inner.observationId);
  for (const { call, own, other } of [
    { call: external, own: outer, other: inner }, { call: sidebar, own: inner, other: outer },
  ]) {
    const download = (id) => call('browser_file', { action: 'download_element', ref: 'e1', observation_id: id });
    assert.equal((await download(own.observationId)).success, true);
    assert.equal((await download(other.observationId)).errorCode, 'OBSERVATION_MISMATCH');
  }
});


test('browser overview is advertised and returns equivalent inventory without an active browser', async (t) => {
  const fixture = createFixture(t, { connected: false });
  const { external, sidebar } = toolEntries(fixture);
  const advertised = sidebarTools(fixture, '列出所有浏览器').find(({ name }) => name === 'browser_control');
  assert.ok(advertised);
  assert.deepEqual(comparableSchema(advertised).properties.action.enum, ['overview']);
  const expected = await external('browser_control', { action: 'overview' });
  assert.equal(expected.success, true);
  assert.deepEqual(await sidebar('browser_control', { action: 'overview' }), expected);
});


test('both entries read the same card library and require takeover before a mutation', async (t) => {
  const fixture = createFixture(t);
  const { external, sidebar } = toolEntries(fixture);
  const expected = await external('manage_card', { action: 'list' });
  assert.equal(expected.success, true);
  assert.deepEqual(await sidebar('manage_card', { action: 'list' }), expected);
  for (const call of [external, sidebar]) {
    assert.equal((await call('manage_card', { action: 'delete', id: 'unknown' })).errorCode, 'BROWSER_TAKEOVER_REQUIRED');
  }
});


test('both entries execute the same guarded batch and expose the existing workflow state', async (t) => {
  const fixture = createFixture(t);
  const { external, sidebar } = toolEntries(fixture);
  assert.deepEqual(await sidebar('browser_workflow', { action: 'status' }), await external('browser_workflow', { action: 'status' }));
  const steps = [
    { tool: 'browser_action', arguments: { action: 'click', selector: '#reference' } },
    { tool: 'browser_wait', arguments: { selector: '#reference', condition: 'visible' } },
  ];
  assert.equal((await sidebar('browser_control', { action: 'acquire' })).success, true);
  for (const call of [external, sidebar]) {
    const result = await call('browser_page_batch', { steps });
    assert.deepEqual(result, { success: true, requested: 2, completed: 2, notAttempted: 0 });
  }
  assert.deepEqual(fixture.actions.map(({ token }) => token), [PAGE, PAGE, PAGE, PAGE]);
  assert.equal(fixture.commands.some(({ command }) => command === 'inspect-page-state'), false);
});

test('stopping either workflow entry completes the in-flight action and does not run the next step', async (t) => {
  for (const entry of ['sidebar', 'external']) {
    const stop = new AbortController();
    const fixture = createFixture(t, { afterAction: ({ action }) => {
      if (action === 'click') stop.abort();
    } });
    const call = toolEntries(fixture, stop.signal)[entry];
    assert.equal((await call('browser_control', { action: 'acquire' })).success, true);
    const click = { tool: 'browser_action', arguments: { action: 'click', selector: '#reference', wait_for_stable: false } };
    const result = await call('browser_workflow', { action: 'run', steps: [click, click] });
    assert.equal(result.status, 'paused', entry);
    assert.equal(result.failedStep, 2, entry);
    assert.equal(fixture.actions.length, 1, entry);
    assert.equal(fixture.commands.filter(({ command, args }) => command === 'automation-takeover' && args.action === 'release').length, 1, entry);
  }
});

function sidebarSoftwareCaller(fixture, events = []) {
  return async (name, args) => {
    const context = {
      windowTools: fixture.windowTools, modelMessages: [], toolEvents: [], traceEvents: [],
      compactToolValue: (value) => value, waitForAbort: (value) => value, emit: (event) => events.push(event),
      isStopped: () => false, connections: fixture.connections,
    };
    await executeSingleTool(context, { id: 'fixture-call', function: { name, arguments: JSON.stringify(args) } });
    return JSON.parse(context.modelMessages[0].content);
  };
}

test('sidebar and external software dispatch share account redaction and command results', async (t) => {
  const fixture = createFixture(t, { vault: { list: () => [{ id: 'fixture-account', email: 'fixture@example.test' }] } });
  const { external } = toolEntries(fixture);
  const events = [];
  const sidebar = sidebarSoftwareCaller(fixture, events);
  const account = { action: 'list', provider: 'fixture-provider' };
  const expected = await external('account_manage', account);
  assert.equal(expected.ok, true);
  assert.equal(expected.data.accounts[0].id, 'fixture-account');
  assert.doesNotMatch(JSON.stringify(expected), /fixture@example\.test/);
  assert.deepEqual(await sidebar('account_manage', account), expected);

  const command = { command: 'echo mcp-parity-fixture' };
  const outcomes = await Promise.all([sidebar('run_command', command), external('run_command', command)]);
  for (const outcome of outcomes) {
    assert.equal(outcome.success, true);
    assert.equal(outcome.exit_code, 0);
    assert.equal(outcome.stdout.trim(), 'mcp-parity-fixture');
  }
  assert.equal(events.filter(({ type }) => type === 'tool_result').length, 2);
});

test('both MCP entries accept local converters for different credential formats and only expose counts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aifree-credential-parity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: Buffer.from,
    decryptString: (value) => value.toString('utf8'),
  };
  const vault = new ProviderAccountVault({ fs, path, safeStorage, filePath: path.join(root, 'vault.json') });
  const fixture = createFixture(t, { vault });
  const events = [];
  const sidebar = sidebarSoftwareCaller(fixture, events);
  const { external } = toolEntries(fixture);
  const provider = 'google';
  const sources = path.join(fixture.workspace, 'sources');
  fs.mkdirSync(sources);
  fs.writeFileSync(path.join(sources, 'first@example.test_fixture-one.json'), 'unused');
  fs.writeFileSync(path.join(sources, 'source.tsv'), 'second@example.test\tfixture-two');
  fs.writeFileSync(path.join(sources, 'convert.cjs'), `
    const fs = require('node:fs');
    const parts = process.argv[2] === 'filenames'
      ? fs.readdirSync('.').find((name) => name.endsWith('.json')).slice(0, -5).split('_')
      : fs.readFileSync('source.tsv', 'utf8').split('\t');
    process.stderr.write(parts[1]);
    process.stdout.write(JSON.stringify([{ email: parts[0], password: parts[1] }]));
    if (process.argv[2] === 'fail') process.exitCode = 1;
  `);
  const run = (call, mode) => call('account_manage', {
    action: 'import', provider, directory: 'sources', command: `node convert.cjs ${mode}`,
  });
  const failed = await run(external, 'fail');
  assert.equal(failed.error.code, 'ACCOUNT_IMPORT_COMMAND_FAILED');
  assert.deepEqual(await run(sidebar, 'fail'), failed);
  assert.deepEqual(vault.list(provider), []);
  const imported = { ok: true, data: { imported: 1, duplicates: 0 } };
  assert.deepEqual(await run(external, 'filenames'), imported);
  assert.deepEqual(await run(sidebar, 'tsv'), imported);
  assert.deepEqual(vault.list(provider).map(({ id }) => vault.getPassword(provider, id)), ['fixture-one', 'fixture-two']);
  assert.doesNotMatch(JSON.stringify({ events, failed }), /fixture-(?:one|two)|(?:first|second)@example\.test/);
});

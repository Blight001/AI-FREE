'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { buildChatToolContext } = require('../../src/app/backend/features/ai-chat/chat-tool-context');
const { dispatchPluginTool } = require('../../src/app/backend/features/ai-chat/chat-tool-executor');
const { createBrowserAutomationBridge } = require('../../src/app/backend/services/browser-automation-bridge');
const { NATIVE_BROWSER_TOOL_DEFINITIONS } = require('../../src/app/backend/services/native-browser-tool-definitions');

const CONNECTION_ID = 'native:automation-fixture';
const TERMINAL_RUN_STATES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
const CARD_TOOL = NATIVE_BROWSER_TOOL_DEFINITIONS.find((tool) => tool.name === 'manage_card');

function createFixture(t, { pageToken } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aifree-automation-mcp-entry-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const calls = [];
  let takeoverActive = false;
  const activeTab = {
    id: '0', title: 'Offline fixture', url: 'https://fixture.invalid/',
    ...(pageToken ? { pageToken } : {}),
  };
  const browserRuntimeManager = {
    listStates: () => [{ profileId: 'automation-fixture', pid: 7412, bridgeConnected: true, status: 'ready' }],
    async dispatchAutomationByProcessId(_pid, command, args = {}, options = {}) {
      calls.push({ command, args, expectedPageToken: options.expectedPageToken });
      if (command === 'list-tabs') {
        return { result: { success: true, activeTab, tabs: [activeTab], activeTabId: '0' } };
      }
      if (command === 'inspect-page-state') {
        return { result: { success: true, url: activeTab.url, values: {},
          target: { found: true, count: 1, visible: true, selector: '#submit' } } };
      }
      if (command === 'inspect-page-diagnostics') {
        return { result: { success: true, cursor: 0, events: [] } };
      }
      if (command === 'observe-page') {
        return { result: { success: true, url: activeTab.url, items: [{
          id: 'fixture-ref', selector: '#submit', tag: 'button', role: 'button', label: 'Submit',
          text: 'Submit', x: 10, y: 10, width: 20, height: 20,
        }] } };
      }
      if (command === 'automation-takeover') {
        if (args.action === 'acquire') takeoverActive = true;
        if (args.action === 'release') takeoverActive = false;
        return { result: { success: true, takeoverActive } };
      }
      if (command === 'perform-action') {
        return { result: { success: true, action: args.action, dispatched: true } };
      }
      throw new Error('Unexpected mocked browser command: ' + command);
    },
    async navigate(_profileId, _runtime, url) {
      activeTab.url = url;
      activeTab.pageToken = 'fixture-page-token-after-navigation';
      return { success: true, url };
    },
  };
  const bridge = createBrowserAutomationBridge({
    cardCacheDir: dataDir,
    workspaceDir: path.join(dataDir, 'workspace'),
    browserRuntimeManager,
    getExternalMcpAccess: () => true,
    logger: { log() {}, warn() {} },
  });
  return { bridge, calls, dataDir, activeTab, takeoverActive: () => takeoverActive };
}

function cardData(name, steps = [{ type: 'end' }]) {
  return { name, description: 'Isolated MCP contract fixture', steps };
}

async function saveCard(bridge, data) {
  const result = await bridge.manageCard(CONNECTION_ID, { action: 'write', cardData: data });
  assert.equal(result.success, true);
  return result.item;
}

async function waitForRun(bridge, runId) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const result = await bridge.manageCard(CONNECTION_ID, { action: 'get_run', run_id: runId });
    if (TERMINAL_RUN_STATES.has(result.run.status)) return result.run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Fixture automation run did not reach a terminal state');
}

async function waitForRunStatus(callManageCard, runId, expectedStatus) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const result = await callManageCard('get_run', { run_id: runId });
    if (result.run.status === expectedStatus) return result.run;
    if (TERMINAL_RUN_STATES.has(result.run.status)) return result.run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Fixture automation run did not reach ${expectedStatus}`);
}

async function capture(operation) {
  try { return { ok: true, value: await operation() }; }
  catch (error) { return { ok: false, error: String(error?.message || error) }; }
}

function sidebarContext(fixture) {
  return {
    bridge: fixture.bridge,
    connections: fixture.bridge.listConnections(),
    localInteraction: true,
    browserTargets: new Map(),
    describeConnections: () => 'automation fixture',
    waitForAbort: (value) => Promise.resolve(value),
  };
}

function entryAdapter(fixture, entry) {
  const context = sidebarContext(fixture);
  const callTool = (tool, args) => entry === 'external'
    ? fixture.bridge.callExternalMcpTool(tool, args)
    : dispatchPluginTool(context, tool, args);
  return {
    callTool,
    manageCard: (action, args = {}) => callTool('manage_card', { action, ...args }),
  };
}

test('public manage_card action definitions are recognized by the bridge card API', async (t) => {
  const fixture = createFixture(t);
  const actions = CARD_TOOL.input_schema.properties.action.enum;
  assert.ok(actions.includes('start_run'));
  assert.ok(actions.includes('list_runs'));
  assert.ok(actions.includes('get_run'));

  const unknown = [];
  for (const action of actions) {
    try {
      await fixture.bridge.manageCard(CONNECTION_ID, {
        action, id: 'missing-card', run_id: 'missing-run',
      });
    } catch (error) {
      if (String(error?.message || error).includes('未知的 manage_card action')) unknown.push(action);
    }
  }
  assert.deepEqual(unknown, [], 'Every publicly advertised action must have a bridge handler');
});

test('external MCP lists, reads, and runs cards through the browser bridge', async (t) => {
  const fixture = createFixture(t, { pageToken: 'fixture-page-token' });
  const card = await saveCard(fixture.bridge, cardData('external-entry-card'));

  const listed = await fixture.bridge.callExternalMcpTool('manage_card', { action: 'list' });
  assert.equal(listed.success, true);
  assert.ok(listed.items.some((item) => item.id === card.id));

  const fetched = await fixture.bridge.callExternalMcpTool('manage_card', { action: 'get', id: card.id });
  assert.equal(fetched.success, true);
  assert.equal(fetched.item.id, card.id);

  await fixture.bridge.callExternalMcpTool('browser_control', { action: 'acquire' });
  const run = await fixture.bridge.callExternalMcpTool('manage_card', { action: 'run', id: card.id });
  assert.equal(run.success, true);
  assert.equal(run.cardName, 'external-entry-card');
});

test('external MCP start_run and run lifecycle actions use the bridge run manager', async (t) => {
  const fixture = createFixture(t, { pageToken: 'fixture-page-token' });
  const card = await saveCard(fixture.bridge, cardData('run-manager-card'));
  await fixture.bridge.callExternalMcpTool('browser_control', { action: 'acquire' });

  const outcomes = [];
  const check = async (action, args, verify) => {
    const outcome = await capture(() => fixture.bridge.callExternalMcpTool('manage_card', { action, ...args }));
    let passed = false;
    try { passed = verify(outcome); } catch (_) { passed = false; }
    outcomes.push({ action, passed, ...(outcome.ok ? {} : { error: outcome.error }) });
    return outcome;
  };

  const started = await check('start_run', { id: card.id }, (outcome) => (
    outcome.ok && outcome.value.success === true && Boolean(outcome.value.run?.id)
  ));

  const bridgeStarted = await fixture.bridge.manageCard(CONNECTION_ID, { action: 'start_run', id: card.id });
  await waitForRun(fixture.bridge, bridgeStarted.run.id);
  const runId = bridgeStarted.run.id;

  await check('list_runs', {}, (outcome) => outcome.ok && outcome.value.success === true);
  await check('get_run', { run_id: runId }, (outcome) => (
    outcome.ok && outcome.value.success === true && outcome.value.run.id === runId
  ));
  await check('list_run_steps', { run_id: runId }, (outcome) => outcome.ok && outcome.value.success === true);
  await check('cancel_run', { run_id: runId }, (outcome) => outcome.ok && outcome.value.success === true);
  await check('retry_run', { run_id: runId }, (outcome) => (
    outcome.ok && outcome.value.success === true && Boolean(outcome.value.run?.id)
  ));
  await check('pause_run', { run_id: runId }, (outcome) => (
    !outcome.ok && /不能暂停/.test(outcome.error)
  ));
  await check('resume_run', { run_id: runId }, (outcome) => (
    !outcome.ok && /未暂停/.test(outcome.error)
  ));
  await check('step_run', { run_id: runId }, (outcome) => (
    !outcome.ok && /单步运行仅可用于已暂停/.test(outcome.error)
  ));

  const retried = outcomes.find((item) => item.action === 'retry_run' && item.passed);
  if (retried) {
    const runList = fixture.bridge.manageCard(CONNECTION_ID, { action: 'list_runs' });
    const retryRun = runList.items.find((item) => item.sourceRunId === runId);
    if (retryRun) await waitForRun(fixture.bridge, retryRun.id);
  }
  assert.deepEqual(outcomes.filter((item) => !item.passed), [], JSON.stringify(outcomes, null, 2));
  assert.equal(started.ok, true);
});

test('local AI sidebar can list cards without a page token but page actions remain bound', async (t) => {
  const fixture = createFixture(t);
  const card = await saveCard(fixture.bridge, cardData('sidebar-read-card'));
  const connections = fixture.bridge.listConnections().map(({ id }) => fixture.bridge.getConnection(id));
  const definitions = buildChatToolContext({
    connections,
    windowTools: { tools: [], has: () => false },
    localInteraction: true,
    initialMessages: [{ role: 'user', content: 'list automation cards' }],
  }).tools;
  assert.ok(definitions.some((tool) => tool.name === 'manage_card'));

  const context = sidebarContext(fixture);
  const listed = await dispatchPluginTool(context, 'manage_card', { action: 'list' });
  assert.equal(listed.success, true);
  assert.ok(listed.items.some((item) => item.id === card.id));

  const action = await dispatchPluginTool(context, 'browser_action', { action: 'click', selector: '#submit' });
  assert.equal(action.success, false);
  assert.equal(action.errorCode, 'BROWSER_TARGET_UNAVAILABLE');
  assert.equal(fixture.calls.some((call) => call.command === 'perform-action'), false);
});

test('both MCP entries reject managed card execution until browser takeover', async (t) => {
  for (const entryName of ['external', 'sidebar']) {
    const fixture = createFixture(t, { pageToken: 'fixture-page-token' });
    const entry = entryAdapter(fixture, entryName);
    const card = await saveCard(fixture.bridge, cardData(`${entryName}-takeover-card`));

    const syncRun = await entry.manageCard('run', { id: card.id });
    const backgroundRun = await entry.manageCard('start_run', { id: card.id });
    assert.equal(syncRun.errorCode, 'BROWSER_TAKEOVER_REQUIRED', entryName);
    assert.equal(backgroundRun.errorCode, 'BROWSER_TAKEOVER_REQUIRED', entryName);

    const runs = await entry.manageCard('list_runs');
    assert.equal(runs.success, true, entryName);
    assert.equal(runs.items.length, 0, entryName);
  }
});

test('local sidebar start_run and get_run share external MCP run state', async (t) => {
  const fixture = createFixture(t, { pageToken: 'fixture-page-token' });
  const card = await saveCard(fixture.bridge, cardData('sidebar-run-parity-card'));
  const external = entryAdapter(fixture, 'external');
  const sidebar = entryAdapter(fixture, 'sidebar');
  await sidebar.callTool('browser_control', { action: 'acquire' });

  const started = await sidebar.manageCard('start_run', { id: card.id });
  assert.equal(started.success, true);
  assert.ok(started.run.id);

  const completed = await waitForRunStatus(sidebar.manageCard, started.run.id, 'succeeded');
  const sidebarRead = await sidebar.manageCard('get_run', { run_id: started.run.id });
  const externalRead = await external.manageCard('get_run', { run_id: started.run.id });
  assert.equal(sidebarRead.success, true);
  assert.equal(sidebarRead.run.status, 'succeeded');
  assert.deepEqual(sidebarRead.run, externalRead.run);
  assert.deepEqual(completed, externalRead.run);
});

test('both MCP entries cancel an in-flight managed card run', async (t) => {
  for (const entryName of ['external', 'sidebar']) {
    const fixture = createFixture(t, { pageToken: 'fixture-page-token' });
    const entry = entryAdapter(fixture, entryName);
    const card = await saveCard(fixture.bridge, cardData(`${entryName}-cancellable-card`, [
      { type: 'delay', delayMs: 30000 }, { type: 'end' },
    ]));
    await entry.callTool('browser_control', { action: 'acquire' });

    const started = await entry.manageCard('start_run', { id: card.id });
    assert.equal(started.success, true, entryName);
    const running = await waitForRunStatus(entry.manageCard, started.run.id, 'running');
    assert.equal(running.status, 'running', entryName);

    const cancelled = await entry.manageCard('cancel_run', { run_id: started.run.id, reason: 'contract test' });
    assert.equal(cancelled.success, true, entryName);
    const finalRun = await waitForRunStatus(entry.manageCard, started.run.id, 'cancelled');
    assert.equal(finalRun.error.code, 'RUN_CANCELLED', entryName);
  }
});

test('both MCP entries reject a managed card action after its document target changes', async (t) => {
  for (const entryName of ['external', 'sidebar']) {
    const fixture = createFixture(t, { pageToken: 'fixture-page-token' });
    const entry = entryAdapter(fixture, entryName);
    await entry.callTool('browser_control', { action: 'acquire' });
    const observed = await entry.callTool('browser_observe', { limit: 10 });
    assert.equal(observed.success, true, entryName);
    const staleRef = observed.items[0].id;
    const card = await saveCard(fixture.bridge, cardData(`${entryName}-target-change-card`, [
      { type: 'mcp', tool: 'browser_tab', arguments: {
        action: 'replace', url: 'https://changed-document.invalid/',
      } },
      { type: 'mcp', tool: 'browser_action', arguments: { action: 'click', ref: staleRef } },
    ]));
    const started = await entry.manageCard('start_run', { id: card.id });
    assert.equal(started.success, true, entryName);
    const finalRun = await waitForRunStatus(entry.manageCard, started.run.id, 'failed');
    const read = await entry.manageCard('get_run', { run_id: started.run.id });
    assert.equal(fixture.activeTab.url, 'https://changed-document.invalid/', entryName);
    assert.equal(read.run.status, 'failed', entryName);
    assert.equal(read.run.output.errorCode, 'OBSERVED_REF_EXPIRED', entryName);
    assert.equal(finalRun.output.errorCode, 'OBSERVED_REF_EXPIRED', entryName);
    assert.equal(fixture.calls.some((call) => call.command === 'perform-action'), false, entryName);
  }
});

test('browser actions and card execution require takeover; card MCP recursion is blocked', async (t) => {
  const fixture = createFixture(t, { pageToken: 'fixture-page-token' });
  const normalCard = await saveCard(fixture.bridge, cardData('takeover-card'));
  const recursiveCard = await saveCard(fixture.bridge, cardData('recursive-card', [{
    type: 'mcp', tool: 'manage_card', arguments: { action: 'list' },
  }]));

  const deniedBrowserAction = await fixture.bridge.callExternalMcpTool('browser_action', {
    action: 'click', selector: '#submit', after: 'none',
  });
  assert.equal(deniedBrowserAction.errorCode, 'BROWSER_TAKEOVER_REQUIRED');
  const deniedCardRun = await fixture.bridge.callExternalMcpTool('manage_card', {
    action: 'run', id: normalCard.id,
  });
  assert.equal(deniedCardRun.errorCode, 'BROWSER_TAKEOVER_REQUIRED');
  assert.equal(fixture.calls.some((call) => call.command === 'perform-action'), false);

  await fixture.bridge.callExternalMcpTool('browser_control', { action: 'acquire' });
  assert.equal(fixture.takeoverActive(), true);
  const allowedBrowserAction = await fixture.bridge.callExternalMcpTool('browser_action', {
    action: 'click', selector: '#submit', after: 'none',
  });
  assert.equal(allowedBrowserAction.success, true, JSON.stringify(allowedBrowserAction));
  assert.equal(fixture.calls.filter((call) => call.command === 'perform-action').length, 1);

  const allowedCardRun = await fixture.bridge.callExternalMcpTool('manage_card', {
    action: 'run', id: normalCard.id,
  });
  assert.equal(allowedCardRun.success, true);
  const recursiveRun = await fixture.bridge.callExternalMcpTool('manage_card', {
    action: 'run', id: recursiveCard.id,
  });
  assert.equal(recursiveRun.success, false);
  assert.match(recursiveRun.error, /禁止递归调用 manage_card/);
});

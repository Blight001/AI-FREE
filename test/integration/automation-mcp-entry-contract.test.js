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

function createFixture(t, { pageToken, connected = true, blockNavigation = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aifree-automation-mcp-entry-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const calls = [];
  let states = connected ? [{ profileId: 'automation-fixture', pid: 7412, bridgeConnected: true, status: 'ready' }] : [];
  let takeoverActive = false;
  let releaseNavigation;
  const navigationGate = new Promise((resolve) => { releaseNavigation = resolve; });
  let markNavigationStarted;
  const navigationStarted = new Promise((resolve) => { markNavigationStarted = resolve; });
  const activeTab = {
    id: '0', title: 'Offline fixture', url: 'https://fixture.invalid/',
    ...(pageToken ? { pageToken } : {}),
  };
  const browserRuntimeManager = {
    listStates: () => states,
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
      if (blockNavigation) {
        markNavigationStarted();
        await navigationGate;
      }
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
  return {
    bridge, calls, dataDir, activeTab,
    get navigationStarted() { return waitForNavigation(navigationStarted); },
    setTargets: (...targets) => { states = targets.map(([profileId, pid]) => ({ profileId, pid, bridgeConnected: true, status: 'ready' })); },
    releaseNavigation: () => releaseNavigation?.(), takeoverActive: () => takeoverActive,
  };
}

async function waitForNavigation(started) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture navigation did not start')), 2000); });
  try { await Promise.race([started, timeout]); } finally { clearTimeout(timer); }
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
  catch (error) { return { ok: false, error: String(error?.message || error), errorCode: error?.code || '' }; }
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
    !outcome.ok && /仅可重试标记为可重试的失败运行/.test(outcome.error)
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

test('each MCP entry can cancel a run started by the other after the browser disconnects', async (t) => {
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

    fixture.setTargets();
    const peer = entryAdapter(fixture, entryName === 'external' ? 'sidebar' : 'external');
    const cancelled = await peer.manageCard('cancel_run', { run_id: started.run.id, reason: 'contract test' });
    assert.equal(cancelled.success, true, entryName);
    const finalRun = await waitForRunStatus(entry.manageCard, started.run.id, 'cancelled');
    assert.equal(finalRun.error.code, 'RUN_CANCELLED', entryName);
    assert.deepEqual((await peer.manageCard('get_run', { run_id: started.run.id })).run, finalRun);
    assert.ok((await peer.manageCard('list_run_steps', { run_id: started.run.id })).items.length);
  }
});

test('both entries expose card management without a browser and defer target checks until execution', async (t) => {
  const fixture = createFixture(t, { connected: false });
  const external = entryAdapter(fixture, 'external');
  const sidebar = entryAdapter(fixture, 'sidebar');
  const externalTools = fixture.bridge.listExternalMcpTools().tools;
  const sidebarDefinitions = buildChatToolContext({
    connections: [], windowTools: { tools: [], has: () => false },
    automationCards: [], localInteraction: true, initialMessages: [{ role: 'user', content: 'manage automation cards' }],
  });
  assert.ok(externalTools.some((tool) => tool.name === 'manage_card'));
  assert.ok(sidebarDefinitions.tools.some((tool) => tool.name === 'manage_card'));

  const written = await external.manageCard('write', { cardData: cardData('offline-managed-card') });
  assert.equal(written.success, true);
  const fetched = await sidebar.manageCard('get', { id: written.item.id });
  assert.equal(fetched.success, true);
  assert.equal(fetched.item.id, written.item.id);

  const externalRun = await capture(() => external.manageCard('start_run', { id: written.item.id }));
  const sidebarRun = await sidebar.manageCard('start_run', { id: written.item.id });
  assert.equal(externalRun.ok, false);
  assert.equal(externalRun.errorCode, 'BROWSER_ROUTE_NOT_FOUND');
  assert.equal(sidebarRun.success, false);
  assert.equal(sidebarRun.errorCode, externalRun.errorCode);
  assert.equal((await external.manageCard('list_runs')).items.length, 0);
});

test('both MCP entries require takeover to retry, resume, or single-step a bound run', async (t) => {
  for (const entryName of ['external', 'sidebar']) {
    const fixture = createFixture(t, { pageToken: 'fixture-page-token' });
    const entry = entryAdapter(fixture, entryName);
    const retryCard = await saveCard(fixture.bridge, cardData(`${entryName}-retry-gate`, [
      { type: 'mcp', tool: 'browser_action', arguments: { action: 'click', selector: '#submit', after: 'none' } },
    ]));
    const failedRun = (await fixture.bridge.manageCard(CONNECTION_ID, { action: 'start_run', id: retryCard.id })).run;
    await waitForRun(fixture.bridge, failedRun.id);
    const retry = await entry.manageCard('retry_run', { run_id: failedRun.id });
    assert.equal(retry.errorCode, 'BROWSER_TAKEOVER_REQUIRED', entryName);

    const pausedCard = await saveCard(fixture.bridge, cardData(`${entryName}-resume-gate`, [
      { type: 'delay', delayMs: 30 }, { type: 'delay', delayMs: 30 }, { type: 'end' },
    ]));
    const pausedRun = (await fixture.bridge.manageCard(CONNECTION_ID, { action: 'start_run', id: pausedCard.id })).run;
    try {
      await waitForRunStatus((action, args) => fixture.bridge.manageCard('', { action, ...args }), pausedRun.id, 'running');
      fixture.bridge.manageCard('', { action: 'pause_run', run_id: pausedRun.id });
      await waitForRunStatus((action, args) => fixture.bridge.manageCard('', { action, ...args }), pausedRun.id, 'paused');
      assert.equal((await entry.manageCard('resume_run', { run_id: pausedRun.id })).errorCode, 'BROWSER_TAKEOVER_REQUIRED', entryName);
      assert.equal((await entry.manageCard('step_run', { run_id: pausedRun.id })).errorCode, 'BROWSER_TAKEOVER_REQUIRED', entryName);
      assert.equal(fixture.bridge.manageCard('', { action: 'get_run', run_id: pausedRun.id }).run.status, 'paused', entryName);
    } finally {
      await fixture.bridge.manageCard('', { action: 'cancel_run', run_id: pausedRun.id });
      await waitForRun(fixture.bridge, pausedRun.id);
    }
  }
});

test('both MCP entries keep a run cancelling until a non-cooperative navigation returns', async (t) => {
  for (const entryName of ['external', 'sidebar']) {
    const fixture = createFixture(t, { pageToken: 'fixture-page-token', blockNavigation: true });
    const entry = entryAdapter(fixture, entryName);
    await entry.callTool('browser_control', { action: 'acquire' });
    const card = await saveCard(fixture.bridge, cardData(`${entryName}-in-flight-navigation`, [
      { type: 'mcp', tool: 'browser_tab', arguments: { action: 'replace', url: 'https://commit-on-return.invalid/' } },
      { type: 'mcp', tool: 'browser_action', arguments: { action: 'click', selector: '#submit', after: 'none' } },
    ]));
    const started = await entry.manageCard('start_run', { id: card.id });
    try {
      await fixture.navigationStarted;

      const stopRequest = await entry.manageCard('cancel_run', { run_id: started.run.id });
      assert.equal(stopRequest.run.status, 'cancelling', entryName);
      assert.equal(stopRequest.run.finishedAt, null, entryName);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal((await entry.manageCard('get_run', { run_id: started.run.id })).run.status, 'cancelling', entryName);
    } finally {
      fixture.releaseNavigation();
      await fixture.bridge.manageCard('', { action: 'cancel_run', run_id: started.run.id });
      await waitForRun(fixture.bridge, started.run.id);
    }
    const finalRun = await waitForRunStatus(entry.manageCard, started.run.id, 'cancelled');
    assert.equal(fixture.activeTab.url, 'https://commit-on-return.invalid/', entryName);
    assert.equal(finalRun.status, 'cancelled', entryName);
    assert.equal(fixture.calls.some((call) => call.command === 'perform-action'), false, entryName);
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

function installSoftwareFixture(fixture, invoke = () => ({ success: true })) {
  const calls = [];
  fixture.bridge.configureExternalMcp({ getWindowTools: () => ({
    tools: [{ name: 'fixture_write', input_schema: { type: 'object' } }], has: (name) => name === 'fixture_write',
    execute: (name, args) => { calls.push(name); return invoke(args); },
  }) });
  return calls;
}

for (const entryName of ['external', 'sidebar']) {
  for (const change of ['release', 'replace-process', 'disconnect']) {
    test(`${entryName} blocks software dispatch after ${change}`, async (t) => {
      const fixture = createFixture(t, { blockNavigation: true });
      const entry = entryAdapter(fixture, entryName);
      const calls = installSoftwareFixture(fixture);
      await entry.callTool('browser_control', { action: 'acquire' });
      const card = await saveCard(fixture.bridge, cardData('dispatch gate', [
        { type: 'navigate', url: 'https://before-change.invalid/' }, { type: 'mcp', tool: 'fixture_write' },
      ]));
      const { run } = await entry.manageCard('start_run', { id: card.id });
      try {
        await fixture.navigationStarted;
        if (change === 'release') {
          await entry.callTool('browser_control', { action: 'release' });
          await entry.callTool('browser_control', { action: 'acquire' });
        } else if (change === 'replace-process') {
          fixture.setTargets(['automation-fixture', 7777]);
          await entry.callTool('browser_control', { action: 'acquire' });
        } else fixture.setTargets(['remaining', 8888]);
      } finally {
        fixture.releaseNavigation();
        await waitForRun(fixture.bridge, run.id);
      }
      const result = (await entry.manageCard('get_run', { run_id: run.id })).run;
      assert.equal(result.status, 'failed');
      assert.equal(result.error.code, { release: 'BROWSER_TAKEOVER_REQUIRED', 'replace-process': 'RUN_TARGET_MISMATCH',
        disconnect: 'BROWSER_CONNECTION_NOT_FOUND' }[change]);
      assert.deepEqual(calls, []);
    });
  }
}

test('permanent deletion from either MCP entry requires takeover and preserves the recycled card on denial', async (t) => {
  for (const name of ['external', 'sidebar']) {
    const fixture = createFixture(t);
    const entry = entryAdapter(fixture, name);
    const peer = entryAdapter(fixture, name === 'external' ? 'sidebar' : 'external');
    const { item } = await entry.manageCard('write', { cardData: cardData('purge-gate') });
    await peer.manageCard('delete', { id: item.id });
    const recycled = () => peer.manageCard('list', { include_deleted: true });
    assert.equal((await recycled()).items[0].id, item.id);
    assert.equal((await entry.manageCard('purge', { id: item.id })).errorCode, 'BROWSER_TAKEOVER_REQUIRED');
    assert.equal((await recycled()).items[0].id, item.id);
    await entry.callTool('browser_control', { action: 'acquire' });
    assert.equal((await entry.manageCard('purge', { id: item.id })).success, true);
    assert.deepEqual((await recycled()).items, []);
  }
});

for (const name of ['external', 'sidebar']) {
  test(`${name} cannot resume, step or retry on a different acquired window`, async (t) => {
    const fixture = createFixture(t);
    const other = 'native:other';
    fixture.setTargets(['automation-fixture', 7412], ['other', 8888]);
    const entry = entryAdapter(fixture, name);
    const calls = installSoftwareFixture(fixture, () => ({ success: false, error: 'fixture failure', retryable: true, actionExecuted: false }));
    const retryCard = await saveCard(fixture.bridge, cardData('retryable', [{ type: 'mcp', tool: 'fixture_write' }]));
    const { run: failed } = await fixture.bridge.manageCard(CONNECTION_ID, { action: 'start_run', id: retryCard.id });
    assert.equal((await waitForRun(fixture.bridge, failed.id)).retryAvailable, true);
    assert.deepEqual(calls, ['fixture_write']);
    const pausedCard = await saveCard(fixture.bridge, cardData('paused target', [
      { type: 'delay', delayMs: 40 }, { type: 'mcp', tool: 'fixture_write' },
    ]));
    const { run: paused } = await fixture.bridge.manageCard(CONNECTION_ID, { action: 'start_run', id: pausedCard.id });
    try {
      await entry.manageCard('pause_run', { run_id: paused.id });
      assert.equal((await waitForRunStatus(entry.manageCard, paused.id, 'paused')).status, 'paused');
      await entry.callTool('browser_control', { action: 'acquire', change_browser: other });
      for (const [action, run_id] of [['resume_run', paused.id], ['step_run', paused.id], ['retry_run', failed.id]]) {
        const error = await capture(() => entry.manageCard(action, { run_id, change_browser: other, connectionId: CONNECTION_ID }));
        assert.equal(error.errorCode, 'RUN_TARGET_MISMATCH');
      }
      assert.equal((await entry.manageCard('get_run', { run_id: paused.id })).run.status, 'paused');
      assert.equal((await entry.manageCard('list_runs')).items.length, 2);
      assert.deepEqual(calls, ['fixture_write']);
    } finally {
      await entry.manageCard('cancel_run', { run_id: paused.id });
      await waitForRun(fixture.bridge, paused.id);
    }
  });
}

test('an MCP continuation of a home-started run guards subsequent software steps', async (t) => {
  for (const action of ['resume_run', 'step_run', 'retry_run']) {
    const fixture = createFixture(t, { blockNavigation: true });
    const entry = entryAdapter(fixture, 'external');
    let fail = action === 'retry_run';
    const calls = installSoftwareFixture(fixture, () => {
      if (!fail) return { success: true };
      fail = false;
      return { success: false, error: 'initial failure', retryable: true, actionExecuted: false };
    });
    const card = await saveCard(fixture.bridge, cardData(action, [
      action === 'retry_run' ? { type: 'mcp', tool: 'fixture_write' } : { type: 'delay', delayMs: 30 },
      { type: 'navigate', url: 'https://after-resume.invalid/' }, { type: 'mcp', tool: 'fixture_write' },
    ]));
    const unsubscribe = fixture.bridge.onRunProgress(({ event, run: active }) => {
      const step = active.steps.at(-1);
      if (event === 'progress' && step?.type === 'delay' && step.phase === 'started') {
        fixture.bridge.manageCard('', { action: 'pause_run', run_id: active.id });
      }
    });
    let { run } = await fixture.bridge.manageCard(CONNECTION_ID, { action: 'start_run', id: card.id });
    try {
      if (action === 'retry_run') assert.equal((await waitForRun(fixture.bridge, run.id)).retryAvailable, true);
      else assert.equal((await waitForRunStatus(entry.manageCard, run.id, 'paused')).status, 'paused');
      await entry.callTool('browser_control', { action: 'acquire' });
      run = (await entry.manageCard(action, { run_id: run.id })).run;
      await fixture.navigationStarted;
      await entry.callTool('browser_control', { action: 'release' });
      fixture.releaseNavigation();
      if (action === 'step_run') {
        assert.equal((await waitForRunStatus(entry.manageCard, run.id, 'paused')).status, 'paused');
        await fixture.bridge.manageCard(CONNECTION_ID, { action: 'resume_run', run_id: run.id });
      }
      assert.equal((await waitForRun(fixture.bridge, run.id)).error.code, 'BROWSER_TAKEOVER_REQUIRED');
      assert.equal(calls.length, action === 'retry_run' ? 2 : 0);
    } finally {
      unsubscribe();
      fixture.releaseNavigation();
      await entry.manageCard('cancel_run', { run_id: run.id });
      await waitForRun(fixture.bridge, run.id);
    }
  }
});

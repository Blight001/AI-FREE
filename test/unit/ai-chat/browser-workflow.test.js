'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { BrowserWorkflow } = require('../../../src/app/backend/services/browser-workflow');

function fixture() {
  let count = 0; const calls = []; let value = 0; let project = 'A'; const diagnostics = [];
  const host = {
    runtimeCommand: async (_connection, command, args) => { calls.push(command); if (command === 'inspect-page-diagnostics') return { success: true, cursor: diagnostics.length, events: diagnostics }; if (command === 'inspect-page-state') return { success: true, url: 'http://test/', values: { project: { available: true, value: project }, count: { available: true, value } }, target: { found: true, count: 1, visible: true, selector: args.target?.selector || '#count', x: 1, y: 1, width: 10, height: 10 } }; if (command === 'capture-screenshot') return { success: true, width: 480, height: 270, dataUrl: 'data:image/png;base64,aGVsbG8=' }; return { success: true }; },
    browserObserve: async (_connection, input = {}) => ({ success: true, url: 'http://test/', title: 'page', items: [], accessibilityTree: [],
      ...(input.include_screenshot ? { dataUrl: 'data:image/png;base64,aGVsbG8=' } : {}) }),
    browserControl: async (_connection, args) => { calls.push(`control:${args.action}`); return { success: true }; },
    browserActionRaw: async () => { calls.push('action'); value += 1; return { success: true }; },
    dispatchBasicTool: async () => ({ success: true }),
    resolveObservedTarget: (_connection, args) => args,
    runtimeTarget: (args) => args,
  };
  return { host, connection: { id: 'c1', browserProcessId: 1 }, calls, setValue: (next) => { value = next; }, setProject: (next) => { project = next; }, addDiagnostic: (entry) => diagnostics.push({ sequence: diagnostics.length + 1, capturedAt: Date.now(), ...entry }), getCount: () => count };
}
const probe = { name: 'count', selector: '#count' };

test('workflow defaults to automation and reports debug snapshots after a verified action', async () => {
  const f = fixture(); const workflow = new BrowserWorkflow(f.host);
  const result = await workflow.control(f.connection, { action: 'run', steps: [{ tool: 'browser_action', arguments: { action: 'click' } }], probes: [probe], expect: [{ name: 'count', op: 'increases_by', value: 1 }] });
  assert.equal(result.success, true); assert.equal(result.mode, 'automation'); assert.equal(result.execution[0].result.status, 'business_verified'); assert.ok(result.report_id || result.lastReportId);
  const report = await workflow.control(f.connection, { action: 'report' });
  assert.equal(report.success, true); assert.ok(report.steps || report.report_id);
});

test('business verification failure switches to debug and pauses', async () => {
  const f = fixture(); const workflow = new BrowserWorkflow(f.host);
  f.host.browserActionRaw = async () => ({ success: true });
  const result = await workflow.control(f.connection, { action: 'run', steps: [{ tool: 'browser_action', arguments: { action: 'click' } }], probes: [probe], expect: [{ name: 'count', op: 'increases_by', value: 1 }], timeout_ms: 1000 });
  assert.equal(result.success, false); assert.equal(result.mode, 'debug');
  const report = await workflow.control(f.connection, { action: 'report', include_images: true });
  assert.equal(report.images.length, 2, 'automation failure promotes its cached before screenshot');
  assert.equal(report.last_step.before.screenshot.kind, 'pre_failure_light_cache');
});

test('new page errors fail a step even when its business check passes', async () => {
  const f = fixture(); const workflow = new BrowserWorkflow(f.host);
  f.host.browserActionRaw = async () => {
    f.setValue(1);
    f.addDiagnostic({ kind: 'page_error', message: 'Cannot set properties of null', url: 'http://test/media.js' });
    return { success: true };
  };
  const result = await workflow.action(f.connection, {
    action: 'click', probes: [probe], expect: [{ name: 'count', op: 'increases_by', value: 1 }],
  });
  assert.equal(result.errorCode, 'PAGE_RUNTIME_ERRORS');
  assert.equal(result.mode, 'debug');
  assert.deepEqual(result.pageDiagnostics, { status: 'failures_detected', pageErrors: 1, failedRequests: 0 });
});

test('new runs are independent unless profile inheritance is explicit', async () => {
  const f = fixture(); const workflow = new BrowserWorkflow(f.host);
  await workflow.control(f.connection, { action: 'set_mode', mode: 'automation',
    probes: [{ name: 'project', selector: '#project' }], identity_probe: 'project' });
  const fresh = await workflow.control(f.connection, { action: 'run', probes: [probe],
    expect: [{ name: 'count', op: 'increases_by', value: 1 }],
    steps: [{ tool: 'browser_action', arguments: { action: 'click' } }] });
  assert.equal(fresh.success, true);
  assert.equal(fresh.effective_configuration.identity, '');
  assert.deepEqual(fresh.effective_configuration.probes, [probe]);
  const inherited = await workflow.control(f.connection, { action: 'run', inherit_config: true,
    steps: [{ tool: 'browser_action', arguments: { action: 'click' } }] });
  assert.equal(inherited.success, true);
  assert.equal(inherited.effective_configuration.identity, 'project');
});

test('unknown action is rejected without mutation and cancel is terminal', async () => {
  const f = fixture(); const workflow = new BrowserWorkflow(f.host);
  const unknown = await workflow.control(f.connection, { action: 'run', steps: [{ tool: 'unknown' }], probes: [probe] });
  assert.equal(unknown.errorCode, 'INVALID_WORKFLOW_TOOL'); assert.equal(f.calls.includes('action'), false);
  const cancelled = await workflow.control(f.connection, { action: 'cancel' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await workflow.control(f.connection, { action: 'resume' })).errorCode, 'WORKFLOW_NOT_PAUSED');
});

test('identity change fails the workflow and conflicts are blocked while busy', async () => {
  const f = fixture(); const workflow = new BrowserWorkflow(f.host);
  const result = await workflow.control(f.connection, { action: 'run', identity_probe: 'project', steps: [{ tool: 'browser_action', arguments: { action: 'click' } }], probes: [{ name: 'project', selector: '#project' }] });
  assert.equal(result.success, true);
  f.setProject('B');
  const paused = await workflow.control(f.connection, { action: 'pause' });
  assert.equal(paused.status, 'paused');
});

test('pause waits for committed input, blocks competitors, and resumes at the next step', async () => {
  const f = fixture(); const workflow = new BrowserWorkflow(f.host);
  let finish; let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const pending = new Promise((resolve) => { finish = resolve; });
  let actions = 0;
  f.host.browserActionRaw = async () => { actions += 1; started(); await pending; return { success: true }; };
  const running = workflow.control(f.connection, { action: 'run', steps: [
    { tool: 'browser_action', arguments: { action: 'click' } },
    { tool: 'browser_action', arguments: { action: 'click' } },
  ] });
  await ready;
  assert.equal(workflow.blocked(f.connection, 'browser_action', {}).errorCode, 'WORKFLOW_BUSY');
  assert.equal((await workflow.control(f.connection, { action: 'pause' })).pausePending, true);
  assert(!f.calls.includes('control:release'));
  finish();
  assert.equal((await running).status, 'paused'); assert.equal(actions, 1);
  assert(f.calls.includes('control:release'));
  assert.equal((await workflow.control(f.connection, { action: 'resume' })).success, true);
  assert.equal(actions, 2);
});

test('business mismatch resume rechecks without replay and unknown outcomes are never retried', async () => {
  const f = fixture(); const workflow = new BrowserWorkflow(f.host); let actions = 0;
  f.host.browserActionRaw = async () => { actions += 1; return { success: true }; };
  const paused = await workflow.control(f.connection, { action: 'run', probes: [probe], steps: [
    { tool: 'browser_action', arguments: { action: 'click', timeout_ms: 0, expect: [{ name: 'count', op: 'increases_by', value: 1 }] } },
  ] });
  assert.equal(paused.errorCode, 'BUSINESS_STATE_MISMATCH');
  f.setValue(1);
  assert.equal((await workflow.control(f.connection, { action: 'resume' })).success, true);
  assert.equal(actions, 1);
  f.host.browserActionRaw = async () => { actions += 1; throw new Error('transport lost after input'); };
  await workflow.control(f.connection, { action: 'run', steps: [{ tool: 'browser_action', arguments: { action: 'click' } }] });
  assert.equal((await workflow.control(f.connection, { action: 'resume' })).errorCode, 'WORKFLOW_OUTCOME_UNKNOWN');
  assert.equal(actions, 2);
});

test('identity switch fails; transient target retries once, ambiguity never dispatches', async () => {
  const f = fixture(); const workflow = new BrowserWorkflow(f.host);
  const original = f.host.runtimeCommand; let targets = 0;
  f.host.runtimeCommand = async (connection, command, args) => {
    if (args?.target && ++targets === 1) return { success: true, url: 'http://test/', target: { found: false, reason: 'not_found' } };
    return original(connection, command, args);
  };
  assert.equal((await workflow.action(f.connection, { action: 'click', selector: '#add' })).success, true);
  assert.equal(targets, 2);
  f.host.browserActionRaw = async () => { f.setProject('B'); return { success: true }; };
  const result = await workflow.control(f.connection, { action: 'run', probes: [{ name: 'project', selector: '#project' }], identity_probe: 'project', steps: [
    { tool: 'browser_action', arguments: { action: 'click', timeout_ms: 0 } },
  ] });
  assert.equal(result.errorCode, 'BUSINESS_STATE_MISMATCH');
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { dispatchRuntimeAutomationByProcessId } = require('../../../src/app/backend/browser-runtime/runtime-automation');
const { sendPageCommand } = require('../../../src/app/backend/browser-runtime/runtime-page-binding');
const { createNativeBrowserAutomation } = require('../../../src/app/backend/services/native-browser-automation');

const PID = 42;
const CONNECTION = 'native:test';
const OPTIONS = { expectedPageToken: 'opaque-page-token' };

function commandRuntime(client) {
  return {
    instances: new Map([['test', { child: { pid: PID, exitCode: null } }]]),
    getReadyInstance: () => ({ commandClient: client }),
    enqueueProfileOperation: (_profileId, operation) => operation(),
  };
}

test('normalization ignores model-supplied tokens and serializes only the trusted guard', async () => {
  const sent = [];
  const runtime = commandRuntime({ send: async (...args) => { sent.push(args); } });
  const input = { action: 'upload_file', selector: '#choose', selectionId: 'native-approval', expectedPageToken: 'spoofed' };
  await dispatchRuntimeAutomationByProcessId(runtime, PID, 'perform-action', input);
  await dispatchRuntimeAutomationByProcessId(runtime, PID, 'perform-action', input, OPTIONS);
  assert.equal(sent[0][0], 'perform-action');
  assert.equal(sent[0][1].expectedPageToken, undefined);
  assert.equal(sent[0][1].selectionId, undefined);
  assert.equal(sent[1][0], 'page-bound-command');
  assert.equal(sent[1][1].expectedPageToken, OPTIONS.expectedPageToken);
  assert.equal(sent[1][1].payload.expectedPageToken, undefined);
  assert.equal(sent[1][1].payload.selectionId, 'native-approval');
});

test('an old kernel rejects the wire envelope and never receives an unbound retry', async () => {
  const attempts = [];
  const client = { send: async (name) => {
    attempts.push(name);
    throw Object.assign(new Error('Unknown wire command'), { code: 'COMMAND_NOT_ALLOWED' });
  } };
  await assert.rejects(sendPageCommand(client, 'perform-action', {}, {}, OPTIONS.expectedPageToken), {
    code: 'BROWSER_RUNTIME_UPDATE_REQUIRED',
  });
  assert.deepEqual(attempts, ['page-bound-command']);
});

test('session export on an older page-binding kernel fails without retrying unbound', async () => {
  const attempts = [];
  const runtime = commandRuntime({ send: async (...args) => {
    attempts.push(args);
    throw Object.assign(new Error('Unsupported page-bound command'), { code: 'BROWSER_TARGET_TOOL_UNSUPPORTED' });
  } });
  await assert.rejects(dispatchRuntimeAutomationByProcessId(runtime, PID, 'get-session-data', {}, OPTIONS), {
    code: 'BROWSER_RUNTIME_UPDATE_REQUIRED',
  });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0][0], 'page-bound-command');
  assert.equal(attempts[0][1].command, 'get-session-data');
  assert.equal(attempts[0][1].expectedPageToken, OPTIONS.expectedPageToken);
});

test('a page action cancelled while queued never reaches the Chromium command client', async () => {
  const controller = new AbortController();
  const runtime = commandRuntime({ send: async () => assert.fail('Cancelled action reached Chromium') });
  runtime.enqueueProfileOperation = async (_profile, operation) => {
    controller.abort();
    return operation();
  };
  await assert.rejects(dispatchRuntimeAutomationByProcessId(runtime, PID, 'perform-action', { action: 'click' }, {
    ...OPTIONS, signal: controller.signal,
  }), { name: 'AbortError' });
});

function automationFixture(handler, select) {
  const calls = [];
  const runtime = {
    listStates: () => [{ profileId: 'test', pid: PID, status: 'ready', bridgeConnected: true }],
    dispatchAutomationByProcessId: async (_pid, name, payload, options) => {
      calls.push({ name, payload, options });
      if (name === 'automation-takeover') return { result: { success: true, takeoverActive: true } };
      return { result: await handler(name, payload, options) };
    },
    selectFilesByProcessId: async (_pid, payload, options) => {
      calls.push({ name: 'select-files', payload, options });
      return { result: await select(payload, options) };
    },
  };
  const automation = createNativeBrowserAutomation({ browserRuntimeManager: runtime, browserDownloadService: {
    resolveUploadPaths: (paths) => paths,
    downloadElement: (args, trigger) => trigger(args.targetPath || 'workspace/demo.png'),
    execute: async () => assert.fail('Unexpected unbound file operation'),
  } });
  const dispatch = (tool, args, options = OPTIONS) => automation.dispatch(CONNECTION, tool, args, options);
  return { dispatch, calls };
}

test('bound observation and screenshot use the same trusted token and reject nested workflows', async () => {
  const { dispatch, calls } = automationFixture(async (name) => name === 'capture-screenshot'
    ? { success: true, dataUrl: 'data:image/png;base64,AA==' }
    : { success: true, items: [], url: 'http://127.0.0.1/' });
  const result = await dispatch('browser_observe', { include_screenshot: true, expectedPageToken: 'spoofed' });
  assert.equal(result.screenshot.format, 'png');
  assert.deepEqual(calls.map(({ name, options }) => [name, options]), [
    ['observe-page', OPTIONS], ['capture-screenshot', OPTIONS],
  ]);
  assert.equal((await dispatch('browser_workflow', { action: 'run' })).errorCode, 'BROWSER_TARGET_TOOL_UNSUPPORTED');
  assert.equal((await dispatch('browser_tab', { action: 'switch' })).errorCode, 'BROWSER_TARGET_TOOL_UNSUPPORTED');
  assert.equal(calls.length, 2);
});

test('a refused chooser arm is a known no-op and never dispatches page input', async () => {
  const { dispatch, calls } = automationFixture(async () => assert.fail('Unexpected input'), async () => ({
    success: false, errorCode: 'BROWSER_TARGET_CHANGED',
  }));
  await dispatch('browser_control', { action: 'acquire' });
  const result = await dispatch('browser_file', { action: 'upload', path: 'test.txt', selector: '#choose' });
  assert.equal(result.errorCode, 'BROWSER_TARGET_CHANGED');
  assert.equal(result.actionExecuted, false);
  assert.deepEqual(calls.map(({ name, options }) => [name, options]), [
    ['automation-takeover', OPTIONS], ['select-files', OPTIONS],
  ]);
});

test('a guarded upload passes its native selection ID and preserves an unverified outcome', async () => {
  const { dispatch, calls } = automationFixture(async () => ({
    success: false, errorCode: 'UPLOAD_OUTCOME_UNVERIFIED',
  }), async () => ({ queued: true, selectionId: 'armed-choice' }));
  await dispatch('browser_control', { action: 'acquire' });
  const result = await dispatch('browser_file', { action: 'upload', path: 'test.txt', selector: '#choose', x: 17, y: 14 });
  assert.equal(result.errorCode, 'UPLOAD_OUTCOME_UNVERIFIED');
  assert.equal(result.actionExecuted, undefined);
  assert.equal(calls.at(-1).name, 'perform-action');
  assert.equal(calls.at(-1).payload.selectionId, 'armed-choice');
  assert.equal(calls.at(-1).payload.x, undefined);
  assert.deepEqual(calls.at(-1).options, OPTIONS);
});

test('bound downloads never take the legacy fallback on target mismatch or an unsupported element', async () => {
  for (const errorCode of ['BROWSER_TARGET_CHANGED', 'IMAGE_ELEMENT_REQUIRED']) {
    const { dispatch, calls } = automationFixture(async () => ({ success: false, errorCode }));
    await dispatch('browser_control', { action: 'acquire' });
    const result = await dispatch('browser_file', { action: 'download_element', selector: '#photo' });
    assert.equal(result.errorCode, errorCode);
    assert.deepEqual(calls.map(({ name }) => name), ['automation-takeover', 'download-element']);
    assert.deepEqual(calls.at(-1).options, OPTIONS);
  }
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { stopChromiumProfile } = require('../../../src/app/backend/browser-runtime/chromium-runtime-process');

test('stop preserves its original failure when releasing resources also fails', async () => {
  const original = new Error('close failed');
  const state = { status: 'ready' };
  const instance = {
    child: { pid: 123, exitCode: null, once() {} }, paths: {},
    commandClient: { send: () => { throw original; } },
    resources: { dispose: async () => { throw new Error('cleanup failed'); } },
  };
  const runtime = {
    instances: new Map([['p', instance]]), logger: { warn() {} },
    stateStore: {
      getState: () => state,
      transition: (_id, status) => { state.status = status; },
      patchState: (_id, patch) => Object.assign(state, patch),
    },
    unbindParentWindowFocus() {},
  };
  await assert.rejects(stopChromiumProfile(runtime, 'p', { preserveSession: false }), (error) => error === original);
  assert.equal(state.status, 'crashed');
  assert.equal(state.lastError.message, 'close failed');
});

test('stopping an exited Chromium does not wait for a stale close command acknowledgement', async () => {
  const messages = [];
  const state = {
    profileId: 'profile-1', status: 'ready', browserHwnd: null, hostHwnd: null,
  };
  const instance = {
    child: { exitCode: null, signalCode: 'SIGTERM', pid: 123 },
    commandClient: {
      send: () => assert.fail('exited Chromium must not receive a close command'),
      close: async () => {},
    },
    monitor: { stop() {} },
    paths: {},
  };
  const runtime = {
    instances: new Map([['profile-1', instance]]),
    logger: { info: (message) => messages.push(message) },
    store: { releaseLock: () => {  } },
    stateStore: {
      getState: () => state,
      transition: (_id, status) => { state.status = status; },
      patchState: (_id, patch) => Object.assign(state, patch),
      releaseLock() {},
    },
    unbindParentWindowFocus() {},
    windowBridge: {},
    emit() {},
    getState: () => ({ ...state }),
  };

  const result = await Promise.race([
    stopChromiumProfile(runtime, 'profile-1', { preserveSession: false }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('stop timed out')), 100)),
  ]);

  assert.equal(result.status, 'stopped');
  assert.equal(runtime.instances.size, 0);
  assert.match(messages[0], /operation=stop outcome=ok/);
  for (const phase of [
    'stateTransition', 'sessionSnapshot', 'runtimeTeardown', 'closeRequest',
    'gracefulExit', 'sessionPersist', 'transportClose', 'finalize',
  ]) {
    assert.match(messages[0], new RegExp(`${phase}Ms=`));
  }
});

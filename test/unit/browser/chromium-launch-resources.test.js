'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChromiumLaunchResources } = require('../../../src/app/backend/browser-runtime/chromium-launch-resources');

function fixture() {
  const calls = [];
  const resources = new ChromiumLaunchResources({}, {
    detachChildWindow: () => calls.push('detach'),
    destroyHostWindow: () => calls.push('destroy'),
  }, null);
  resources.hostHwnd = 'host';
  resources.browserHwnd = 'browser';
  resources.commandClient = { close: async () => { calls.push('pipe'); } };
  resources.proxyAuthBridge = { close: async () => { calls.push('proxy'); } };
  return { calls, resources };
}

test('repeated resource release closes each acquired resource once', async () => {
  const { calls, resources } = fixture();
  await Promise.all([
    resources.dispose({ processExited: true }),
    resources.dispose({ processExited: true }),
  ]);
  assert.deepEqual(calls, ['pipe', 'detach', 'destroy', 'proxy']);
});

test('an unconfirmed exit retains environment resources until the process really exits', async () => {
  const { calls, resources } = fixture();
  await resources.dispose({ processExited: false });
  assert.deepEqual(calls, ['pipe', 'detach', 'destroy']);
  await resources.dispose({ processExited: true });
  assert.deepEqual(calls, ['pipe', 'detach', 'destroy', 'proxy']);
});

test('environment cleanup still runs after transport release fails', async () => {
  const { calls, resources } = fixture();
  resources.commandClient.close = async () => { throw new Error('pipe failed'); };
  await assert.rejects(resources.dispose({ processExited: true }), /pipe failed/);
  assert.deepEqual(calls, ['detach', 'destroy', 'proxy']);
});

test('failed transport cleanup can retry without releasing successful resources twice', async () => {
  const { calls, resources } = fixture();
  let attempts = 0;
  resources.commandClient.close = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('pipe failed');
    calls.push('pipe');
  };
  await assert.rejects(resources.dispose(), /pipe failed/);
  await resources.dispose({ processExited: true });
  assert.equal(attempts, 2);
  assert.deepEqual(calls, ['detach', 'destroy', 'pipe', 'proxy']);
});

test('host destruction is attempted even if detaching its child fails', async () => {
  const { calls, resources } = fixture();
  resources.windowBridge.detachChildWindow = () => { throw new Error('child unavailable'); };
  await assert.rejects(resources.dispose({ processExited: true }), /child unavailable/);
  assert.deepEqual(calls, ['pipe', 'destroy', 'proxy']);
  await resources.dispose({ processExited: true });
  assert.deepEqual(calls, ['pipe', 'destroy', 'proxy']);
});

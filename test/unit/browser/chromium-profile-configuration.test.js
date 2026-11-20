'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ChromiumRuntime } = require('../../../src/app/backend/browser-runtime/chromium-runtime');
const { RuntimeStateStore } = require('../../../src/app/backend/browser-runtime/runtime-state-store');

function fixture() {
  const runtime = new ChromiumRuntime({ stateStore: { getState: () => ({ status: 'ready' }) } });
  const instance = { profile: { proxyServer: 'old' }, appliedProfile: { proxyServer: 'old' } };
  runtime.instances.set('p', instance);
  const restarts = [];
  runtime.restartNow = async (id) => { restarts.push(id); return { status: 'ready' }; };
  return { runtime, instance, restarts };
}

test('configuration updates wait for active operations and preserve applied snapshots', async () => {
  const { runtime, instance, restarts } = fixture();
  let release;
  const active = runtime.enqueueProfileOperation('p', () => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  await Promise.resolve();
  const update = { proxyServer: 'new' };
  const pending = runtime.updateProfileConfiguration('p', update);
  assert.equal(instance.profile.proxyServer, 'old');
  release();
  await active;
  const result = await pending;
  assert.equal(result.data.restarted, false);
  assert.equal(instance.profile.proxyServer, 'new');
  assert.equal(instance.appliedProfile.proxyServer, 'old');
  assert.deepEqual(restarts, []);
});

test('unchanged configuration skips restarts but retries a previously failed application', async () => {
  const { runtime, restarts } = fixture();
  const options = { restart: true, onlyIfChanged: true };
  assert.equal((await runtime.updateProfileConfiguration('p', { proxyServer: 'old' }, options)).data.restarted, false);
  runtime.restartNow = async () => { throw new Error('restart failed'); };
  await assert.rejects(runtime.updateProfileConfiguration('p', { proxyServer: 'new' }, options), /restart failed/);
  runtime.restartNow = async (id) => { restarts.push(id); return { status: 'ready' }; };
  assert.equal((await runtime.updateProfileConfiguration('p', { proxyServer: 'new' }, options)).data.restarted, true);
  assert.deepEqual(restarts, ['p']);
  assert.equal((await runtime.updateProfileConfiguration('missing', {}, options)).data.found, false);
});

test('runtime state updates validate transitions and isolate snapshots', () => {
  const states = new RuntimeStateStore();
  states.createState('业务::profile', 'chromium');
  assert.throws(() => states.patchState('业务::profile', { status: 'ready' }), /非法运行时状态迁移/);
  states.transition('业务::profile', 'starting', { bounds: { width: 800, height: 600 } });
  const snapshot = states.getState('业务::profile');
  snapshot.bounds.width = 1;
  assert.equal(states.getState('业务::profile').bounds.width, 800);
});

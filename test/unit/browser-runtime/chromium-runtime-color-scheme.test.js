'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ChromiumRuntime } = require('../../../src/app/backend/browser-runtime/chromium-runtime');

function createRuntime(statuses, send) {
  const stateStore = {
    getState(profileId) {
      const status = statuses.get(profileId);
      return status ? { profileId, status } : null;
    },
  };
  const runtime = new ChromiumRuntime({
    stateStore,
    logger: { warn() {} },
  });
  for (const profileId of statuses.keys()) {
    runtime.instances.set(profileId, {
      commandClient: { send: (command, payload) => send(profileId, command, payload) },
    });
  }
  return runtime;
}

test('preferred browser color scheme updates ready and hidden Profiles, not starting Profiles', async () => {
  const statuses = new Map([
    ['visible', 'ready'],
    ['hidden', 'hidden'],
    ['starting', 'starting'],
  ]);
  const sent = [];
  const runtime = createRuntime(statuses, async (...args) => sent.push(args));

  const result = await runtime.setPreferredColorScheme('dark');

  assert.equal(result.ok, true);
  assert.equal(result.colorScheme, 'dark');
  assert.deepEqual(sent, [
    ['visible', 'set-color-scheme', { colorScheme: 'dark' }],
    ['hidden', 'set-color-scheme', { colorScheme: 'dark' }],
  ]);
  assert.equal(runtime.preferredColorScheme, 'dark');
});

test('gold maps to dark and an old Chromium kernel is reported as unsupported without claiming success', async () => {
  const statuses = new Map([['visible', 'ready']]);
  const runtime = createRuntime(statuses, async () => {
    throw Object.assign(new Error('Unknown command'), { code: 'COMMAND_NOT_ALLOWED' });
  });

  const result = await runtime.setPreferredColorScheme('gold');

  assert.equal(result.ok, false);
  assert.equal(result.colorScheme, 'dark');
  assert.equal(result.results[0].code, 'BROWSER_RUNTIME_UPDATE_REQUIRED');
});

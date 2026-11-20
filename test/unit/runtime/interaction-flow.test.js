'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runFlow, validateFlow } = require('../../helpers/flows/runner');
const { interactions, nonInteractive } = require('../../../scripts/verification/interactions');
const { verificationPlan } = require('../../../scripts/verification/catalog');
const { resolvePlan } = require('../../../scripts/verification/plans');
const { domainContract, bindDomain } = require('../../helpers/flows/domains');
const { nativeBrowserDrivers } = require('../../helpers/flows/native-browser-drivers');

const step = (id, use, args, expected = true) => ({ id, use, args, expect: [{ path: 'ok', op: 'equals', value: expected }] });
const flow = (...steps) => ({ schemaVersion: 1, id: 'test-flow', steps });

test('flow resolves typed inputs and prior outputs without changing scenario', async () => {
  const calls = [];
  const scenario = flow(step('create', 'write', { value: { $ref: 'input.value' } }),
    step('verify', 'read', { id: { $ref: 'create.id' } }));
  const drivers = {
    write: async (args) => { calls.push(args); return { ok: true, id: 42 }; },
    read: async (args) => { calls.push(args); return { ok: args.id === 42 }; },
  };
  const before = JSON.stringify(scenario);
  assert.equal((await runFlow(scenario, { drivers, input: { value: false } })).ok, true);
  assert.deepEqual(calls, [{ value: false }, { id: 42 }]);
  assert.equal(JSON.stringify(scenario), before);
});

test('expected failures continue; unexpected failures stop without replay or exposing secrets', async () => {
  let mutations = 0;
  const scenario = flow(step('rejected', 'reject', {}, false), step('mutate', 'write', {}), step('later', 'write', {}));
  const result = await runFlow(scenario, { drivers: {
    reject: async () => ({ ok: false }),
    write: async () => { mutations++; throw new Error('token=secret-page-value'); },
  } });
  assert.equal(mutations, 1);
  assert.equal(result.ok, false);
  assert.deepEqual(result.data.steps.map((entry) => entry.status), ['passed', 'failed']);
  assert(!JSON.stringify(result).includes('secret-page-value'));
});

test('flow validates all steps before side effects and rejects implicit retry or executable steps', async () => {
  let calls = 0;
  const drivers = { write: async () => { calls++; return { ok: true }; } };
  for (const invalid of [
    step('bad', 'eval', {}),
    { ...step('bad', 'write', {}), retry: 2 },
    step('bad', 'write', { value: { $ref: 'later.value' } }),
    step('bad', 'write', { value: { $ref: 'input.constructor' } }),
    { ...step('bad', 'write', {}), expect: [] },
  ]) {
    await assert.rejects(runFlow(flow(step('first', 'write', {}), invalid), { drivers }));
  }
  assert.equal(calls, 0);
});

test('cancellation waits for active mutation and prevents subsequent actions', async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await runFlow(flow(step('first', 'write', {}), step('second', 'write', {})), {
    signal: controller.signal,
    drivers: { write: async () => { calls++; controller.abort(); return { ok: true }; } },
  });
  assert.equal(calls, 1);
  assert.equal(result.data.status, 'cancelled');
});

test('cancellation during the final mutation reports cancelled after checking its outcome', async () => {
  const controller = new AbortController();
  const result = await runFlow(flow(step('last', 'write', {})), {
    signal: controller.signal,
    drivers: { write: async () => { controller.abort(); return { ok: true }; } },
  });
  assert.equal(result.data.steps[0].status, 'passed');
  assert.equal(result.data.status, 'cancelled');
  assert.equal(result.ok, false);
});

test('an active flow uses its own input and scenario snapshot', async () => {
  const scenario = flow(step('first', 'write', {}), step('second', 'read', { value: { $ref: 'input.value' } }));
  const input = { value: 'original' };
  const values = [];
  const result = await runFlow(scenario, { input, drivers: {
    write: async () => {
      scenario.steps[1].use = 'unknown';
      input.value = 'changed';
      return { ok: true };
    },
    read: async (args) => { values.push(args.value); return { ok: true }; },
  } });
  assert.equal(result.ok, true);
  assert.deepEqual(values, ['original']);
});

test('every acceptance script is classified and selected interactions retain prerequisites', () => {
  const directory = path.resolve(__dirname, '../../acceptance/scripts');
  const classified = new Set([...interactions.map((entry) => entry.file), ...Object.keys(nonInteractive)]);
  assert.deepEqual(fs.readdirSync(directory).filter((file) => file.endsWith('.js') && !classified.has(file)), []);
  const plan = verificationPlan('interactions', { only: ['native-workflow'] });
  assert.deepEqual(plan.map((entry) => entry.id), ['prepare', 'native-build', 'native-workflow']);
  assert.throws(() => verificationPlan('interactions', { only: ['arbitrary-command'] }), /UNKNOWN_INTERACTION/);
  assert(!verificationPlan('interactions').some((entry) => entry.id === 'installed-mcp'));
  const scenario = require('../../acceptance/flows/native-workflow.json');
  const drivers = Object.fromEntries([...new Set(scenario.steps.map((entry) => entry.use))].map((name) => [name, () => {}]));
  validateFlow(scenario, drivers, domainContract('native-browser'));
});

test('domain binding and independent evidence are mandatory before actions start', async () => {
  assert.throws(() => bindDomain('remote-peer', { start() {} }), /DOMAIN_DRIVER_MISMATCH/);
  let writes = 0;
  const binding = bindDomain('remote-peer', {
    start: async () => { writes++; return { ok: true }; }, frame: async () => {}, waitEvent: async () => {},
  });
  await assert.rejects(runFlow(flow(step('write', 'start', {})), binding), /FLOW_INDEPENDENT_ORACLE_REQUIRED/);
  const wrongDomain = { ...flow(step('observe', 'waitEvent', {})), domain: 'native-browser' };
  await assert.rejects(runFlow(wrongDomain, binding), /FLOW_DOMAIN_MISMATCH/);
  assert.equal(writes, 0);
});

test('native independent readback catches false action success and never repeats the write', async () => {
  let writes = 0;
  const automation = {
    dispatch: async () => { writes++; return { success: true }; },
    requireConnection: (id) => ({ id }),
    runtimeCommand: async () => ({ values: { count: { value: 0 } } }),
  };
  const scenario = { schemaVersion: 1, id: 'false-success', domain: 'native-browser', steps: [
    { id: 'click', use: 'browser_action', args: { action: 'click', selector: '#add' },
      expect: [{ path: 'success', op: 'equals', value: true }] },
    { id: 'readback', use: 'inspectState', args: { probes: [{ name: 'count', selector: '.item', read: 'count' }] },
      expect: [{ path: 'values.count.value', op: 'equals', value: 1 }] },
  ] };
  const result = await runFlow(scenario, nativeBrowserDrivers(automation, 'test', 'http://127.0.0.1:1'));
  assert.equal(writes, 1);
  assert.equal(result.ok, false);
  assert.equal(result.data.steps[0].evidence, 'action');
  assert.equal(result.data.steps[1].id, 'readback');
  assert.equal(result.data.steps[1].phase, 'assertion');
});

test('custom verification flows order dependencies and validate scenarios before launch', () => {
  const baseDirectory = path.resolve(__dirname, '../../acceptance/flows');
  const plan = resolvePlan(require('../../acceptance/flows/project-browser.json'), baseDirectory);
  assert.deepEqual(plan.map((entry) => entry.id), ['prepare', 'native-build', 'native-workflow',
    'remote-browser-peer', 'browser-settings-ui', 'packaged-sidebar']);
  assert.equal(plan[2].scenario.schemaVersion, 1);
  assert.equal(plan[3].scenario.id, 'remote-browser-peer');
  const invalid = [
    { id: 'anything' },
    { id: 'native-workflow', command: 'echo anything' },
    { id: 'browser-settings-ui', scenario: 'native-workflow.json' },
  ];
  for (const check of invalid) {
    assert.throws(() => resolvePlan({ schemaVersion: 1, id: 'test-plan', checks: [check] }, baseDirectory));
  }
  assert.throws(() => resolvePlan({ schemaVersion: 1, id: 'test-plan', checks: [{ id: 'prepare' }, { id: 'prepare' }] }));
});

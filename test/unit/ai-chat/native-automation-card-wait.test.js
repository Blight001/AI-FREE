'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { runCard } = require('../../../src/app/backend/services/automation-card-execution');
const { createAutomationCardMcpRouter } = require('../../../src/app/backend/services/automation-card-mcp-router');
const { NATIVE_BROWSER_TOOL_DEFINITIONS } = require('../../../src/app/backend/services/native-browser-tool-definitions');

async function runWait(step) {
  const calls = [];
  const router = createAutomationCardMcpRouter({
    getConnection: () => ({ tools: NATIVE_BROWSER_TOOL_DEFINITIONS }),
    dispatch: async (_id, tool, args) => { calls.push({ tool, args }); return { success: true }; },
  });
  const card = { steps: [{ type: 'wait', ...step }] };
  const result = await runCard(card, {}, (tool, args) => router.execute('test-browser', tool, args));
  return { result, calls };
}

for (const [label, step] of [
  ['selector with the native default deadline', { selector: '#ready' }],
  ['selector with explicit ms', { selector: '#ready', ms: 125 }],
  ['selector with explicit timeout_ms', { selector: '#ready', timeout_ms: 275 }],
  ['URL condition without a selector', { condition: 'url_matches', value: '/done' }],
  ['observation reference without a selector', { ref: 'r1', observation_id: 'obs1' }],
  ['fixed wait with the native default duration', {}],
  ['fixed wait with explicit ms', { ms: 25 }],
]) {
  test(`card wait forwards ${label}`, async () => {
    const { result, calls } = await runWait(step);
    assert.equal(result.success, true, result.error);
    assert.equal(calls.length, 1);
    const { tool, args } = calls[0];
    assert.equal(tool, 'browser_wait');
    for (const [key, value] of Object.entries(step)) assert.equal(args[key], value);
    for (const key of ['ms', 'timeout_ms', 'selector']) {
      assert.equal(Object.hasOwn(args, key), Object.hasOwn(step, key), key);
    }
  });
}

for (const [label, step, duration] of [
  ['fixed duration', { timeout: 40 }, 40],
  ['element deadline', { wait_for_element: '#ready', timeout: 200 }, 200],
  ['explicit ms', { selector: '#ready', ms: 325, timeout: 200 }, 325],
  ['explicit timeout_ms', { selector: '#ready', ms: 325, timeout_ms: 450, timeout: 200 }, 450],
]) {
  test(`card wait handles legacy timeout with ${label}`, async () => {
    const { result, calls } = await runWait(step);
    assert.equal(result.success, true, result.error);
    const { args } = calls[0];
    assert.equal(args.selector, step.selector || step.wait_for_element);
    assert.equal(args.selector ? args.timeout_ms ?? args.ms : args.ms, duration);
    if (step.ms !== undefined) assert.equal(args.ms, step.ms);
  });
}

test('card wait rejects invalid explicit timing before browser dispatch', async () => {
  const { result, calls } = await runWait({ selector: '#ready', timeout_ms: '250', timeout: 100 });
  assert.equal(result.errorCode, 'AUTOMATION_ARGUMENT_INVALID');
  assert.match(result.error, /inputs\.timeout_ms/);
  assert.deepEqual(calls, []);
});

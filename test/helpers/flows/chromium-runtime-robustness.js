'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { terminateProcessTree } = require('../../../src/app/backend/browser-runtime/chromium-runtime-process');

async function verifyLastTabReplacement(manager, profileId, original, secondUrl) {
  const chromium = manager.chromium;
  await chromium.openTabs(profileId, [secondUrl]);
  const instance = chromium.instances.get(profileId);
  const closeTab = () => instance.commandClient.send('close-tab', { index: 0 });
  const first = await closeTab();
  assert.equal(first.result.closed, true);
  assert.equal(first.result.count, 1);

  const last = await closeTab();
  assert.equal(last.result.browserWillClose, undefined);
  assert.equal(last.result.closed, true);
  assert.equal(last.result.count, 1);
  const { result } = await chromium.listTabs(profileId);
  assert.equal(result.count, 1);
  assert.equal(result.activeTab.url, 'chrome://new-tab-page/');
  assert.equal(chromium.getState(profileId).pid, original.pid);
  assert.equal(chromium.getState(profileId).sessionId, original.sessionId);
}

async function waitForReplacement(chromium, profileId, oldPid) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const state = chromium.getState(profileId);
    if (state.status === 'hidden' && state.pid !== oldPid) return state;
    await delay(100);
  }
  assert.fail(`Hidden Chromium did not recover: status=${chromium.getState(profileId)?.status}`);
}

async function acceptChromiumRobustness({ manager, origin, stopAndAssertReleased }) {
  const profileId = 'phase3_runtime_robustness';
  const chromium = manager.chromium;
  const original = await chromium.launchProfile({ profileId, initialUrl: 'about:blank' },
    { x: 0, y: 41, width: 1180, height: 719 });
  await verifyLastTabReplacement(manager, profileId, original, `${origin}/page`);
  await chromium.hide(profileId);

  const crashed = once(chromium, 'crashed', { signal: AbortSignal.timeout(10000) });
  assert.equal(await terminateProcessTree(original.pid), true);
  const [failure] = await crashed;
  assert.equal(failure.lastError.code, 'CHROMIUM_PROCESS_EXITED');
  const recovered = await waitForReplacement(chromium, profileId, original.pid);
  assert.notEqual(recovered.sessionId, original.sessionId);
  assert.equal(recovered.bridgeConnected, true);
  assert((await chromium.listTabs(profileId)).result.count > 0);
  await stopAndAssertReleased(profileId, recovered.pid);
  console.log('[phase3-acceptance] last-tab replacement, unexpected exit recovery and explicit stop passed');
}

module.exports = { acceptChromiumRobustness };

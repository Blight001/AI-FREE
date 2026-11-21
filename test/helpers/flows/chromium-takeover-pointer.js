'use strict';

const assert = require('node:assert/strict');
const { createNativeBrowserAutomation } = require('../../../src/app/backend/services/native-browser-automation');
const { dispatchPluginTool } = require('../../../src/app/backend/features/ai-chat/chat-tool-executor');

async function verifySidebarReload({ manager, profileId, origin, waitForRequest }) {
  const bridge = createNativeBrowserAutomation({ browserRuntimeManager: manager });
  const connection = bridge.getConnection(`native:${profileId}`);
  const context = { localInteraction: true, browserTargets: new Map(), connections: [connection],
    bridge, describeConnections: () => connection.name, waitForAbort: async (value) => value };
  const dispatch = (tool, args) => dispatchPluginTool(context, tool, { change_browser: connection.name, ...args });
  const assertSuccess = (result) => assert.equal(result.success, true, JSON.stringify(result));
  assertSuccess(await dispatch('browser_control', { action: 'acquire' }));
  assertSuccess(await dispatch('browser_tab', { action: 'navigate', url: `${origin}/coordinate-input` }));
  const observe = () => dispatch('browser_observe', { keyword: '发布', mark: false });
  const ready = await dispatch('browser_wait', { condition: 'visible', selector: '#publish' });
  assertSuccess(ready);
  const before = await observe();
  const item = (snapshot) => snapshot.items.find(({ selector }) => selector === '#publish');
  assert(item(before));

  assertSuccess(await dispatch('browser_tab', { action: 'reload', tab_id: 1 }));
  const after = await observe();
  assert(item(after));
  const click = (snapshot) => dispatch('browser_action', {
    action: 'click', ref: item(snapshot).id, observation_id: snapshot.observationId,
  });
  assert.equal((await click(before)).errorCode, 'OBSERVATION_MISMATCH');
  assertSuccess(await click(after));
  await waitForRequest((request) => request.path === '/input-result'
    && request.query.includes('profile=coordinate&trusted=true'));
  assertSuccess(await dispatch('browser_tab', { action: 'close', tab_id: 1 }));
  assertSuccess(await dispatch('browser_control', { action: 'release' }));
  console.log('[phase3-acceptance] sidebar reloads tab 1 and clicks a fresh ref after a single acquire');
}

async function verifyTakeoverPointer({ manager, pid, profileId, url }) {
  const command = async (name, payload = {}) => (await manager.dispatchAutomationByProcessId(pid, name, payload)).result;
  const control = (action) => command('automation-takeover', { action });
  const assertStatus = async (active, step) => {
    const status = await control('status');
    assert.equal(status.takeoverActive, active, `${step}: page takeover`);
    assert.equal(status.pointerVisible, active, `${step}: Chromium AI cursor visibility`);
  };
  await assertStatus(false, 'bridge connected');
  assert.equal((await command('observe-page', { show_highlights: false })).success, true);
  await assertStatus(false, 'read-only commands');
  assert.equal((await control('acquire')).takeoverActive, true);
  await assertStatus(true, 'takeover acquired');
  assert.equal((await control('release')).takeoverActive, false);
  await assertStatus(false, 'takeover released');
  assert.equal((await control('acquire')).takeoverActive, true);
  const secondUrl = new URL(url);
  secondUrl.searchParams.set('pointer-tab', 'second');
  const opened = await manager.openTabs(profileId, 'chromium', [secondUrl.href]);
  assert.equal(opened.result.opened, 1);
  await assertStatus(true, 'new active tab');
  assert.equal((await command('activate-tab', { index: 0 })).index, 0);
  await assertStatus(true, 'returned to original tab');
  assert.equal((await command('activate-tab', { index: 1 })).index, 1);
  assert.equal((await command('close-tab', { index: 1 })).closed, true);
  await assertStatus(true, 'active tab closed');
  assert.equal((await control('release')).takeoverActive, false);
  await assertStatus(false, 'browser takeover released');
  console.log('[phase3-acceptance] AI cursor follows the active tab during browser takeover');
}

module.exports = { verifySidebarReload, verifyTakeoverPointer };

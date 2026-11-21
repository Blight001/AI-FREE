'use strict';

const assert = require('node:assert/strict');

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
  await assertStatus(false, 'new active tab');
  assert.equal((await command('activate-tab', { index: 0 })).index, 0);
  await assertStatus(false, 'returned to original tab');
  assert.equal((await command('close-tab', { index: 1 })).closed, true);
  console.log('[phase3-acceptance] AI cursor follows explicit page takeover');
}

module.exports = { verifyTakeoverPointer };

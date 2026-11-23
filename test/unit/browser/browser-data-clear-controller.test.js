'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createBrowserDataClearController } = require('../../../src/app/backend/features/browser/browser-data-clear-controller');

function createFixture() {
  const events = [];
  const mainContents = {
    id: 10,
    isDestroyed: () => false,
    send: (channel, payload) => events.push({ target: 'main', channel, payload }),
  };
  const sideContents = {
    id: 20,
    isDestroyed: () => false,
    send: (channel, payload) => events.push({ target: 'side', channel, payload }),
  };
  const tabs = new Map([['profile-1', { id: 'profile-1', fixedTitle: '测试浏览器' }]]);
  const cleared = [];
  let sidebarEnsured = 0;
  let menuClosed = 0;
  const ui = {
    browserRuntimeManager: { clearData: async (profileId) => { cleared.push(profileId); return { cleared: true }; } },
    ensureSidebarVisible: () => { sidebarEnsured += 1; },
    getMainWindow: () => ({ isDestroyed: () => false, webContents: mainContents }),
    getSideView: () => ({ webContents: sideContents }),
    getTabs: () => tabs,
  };
  const controller = createBrowserDataClearController(ui, () => { menuClosed += 1; });
  return {
    controller,
    events,
    mainContents,
    sideContents,
    cleared,
    getSidebarEnsured: () => sidebarEnsured,
    getMenuClosed: () => menuClosed,
  };
}

test('main-window clear request requires confirmation from its own webContents', async () => {
  const fixture = createFixture();
  const requested = await fixture.controller.request({ sender: fixture.mainContents }, { profileId: 'profile-1' });
  assert.equal(requested.ok, true);
  assert.equal(requested.pending, true);
  assert.deepEqual(fixture.events.map(({ target }) => target), ['main']);
  assert.equal(fixture.cleared.length, 0);
  assert.equal(fixture.getSidebarEnsured(), 0);

  const requestId = fixture.events[0].payload.requestId;
  const rejected = await fixture.controller.resolve(
    { sender: fixture.sideContents },
    { requestId, confirmed: true },
  );
  assert.equal(rejected.ok, false);
  assert.equal(fixture.cleared.length, 0);

  const cancelled = await fixture.controller.resolve(
    { sender: fixture.mainContents },
    { requestId, confirmed: false },
  );
  assert.deepEqual(cancelled, { ok: true, cancelled: true });
  assert.equal(fixture.cleared.length, 0);
});

test('sidebar clear confirmation remains scoped to the sidebar and still clears on approval', async () => {
  const fixture = createFixture();
  const requested = await fixture.controller.request({ sender: fixture.sideContents }, { profileId: 'profile-1' });
  assert.equal(requested.pending, true);
  assert.equal(fixture.events[0].target, 'side');
  assert.equal(fixture.getSidebarEnsured(), 1);

  const result = await fixture.controller.resolve(
    { sender: fixture.sideContents },
    { requestId: fixture.events[0].payload.requestId, confirmed: true },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(fixture.cleared, ['profile-1']);
  assert.equal(fixture.getMenuClosed(), 1);
});

test('untrusted webContents cannot request browser data clearing', async () => {
  const fixture = createFixture();
  const result = await fixture.controller.request({ sender: { id: 30 } }, { profileId: 'profile-1' });
  assert.equal(result.ok, false);
  assert.equal(fixture.events.length, 0);
  assert.equal(fixture.cleared.length, 0);
});

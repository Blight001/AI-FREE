'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const { resolveAppShellViewPath } = require('../../../src/app/backend/config/paths');
const { registerVipShopIpc } = require('../../../src/app/backend/features/account/register-vip-shop-ipc');

function fixture(openTutorialTab) {
  const mainFrame = { url: `${pathToFileURL(resolveAppShellViewPath())}?dev=0` };
  const contents = { mainFrame, isDestroyed: () => false };
  let handler;
  const dispose = registerVipShopIpc({
    ipc: { handle(channel, fn) {
      assert.equal(channel, 'account-open-vip-shop');
      handler = fn;
      return () => { handler = null; };
    } },
    getMainWindow: () => ({ webContents: contents }),
    openTutorialTab,
  });
  return { dispose, event: { sender: contents, senderFrame: mainFrame },
    invoke: (...args) => handler(...args), isRegistered: () => Boolean(handler) };
}

test('only the home main frame can open the fixed shop inside the tutorial browser', async () => {
  const calls = [];
  const { event, invoke, dispose, isRegistered } = fixture(async (...args) => {
    calls.push(args);
    return 'tutorial-profile';
  });
  for (const sender of [{ ...event, sender: {} }, { ...event, senderFrame: { ...event.senderFrame } }]) {
    assert.equal((await invoke(sender)).error.code, 'VIP_SHOP_HOME_REQUIRED');
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(await invoke(event, { url: 'https://example.test/' }), { ok: true, data: { tabId: 'tutorial-profile' } });
  assert.deepEqual(calls, [['', { destination: 'shop', focusBrowser: true }]]);
  dispose();
  assert.equal(isRegistered(), false);
});

test('a failed browser operation returns a retryable error, including the existing window limit', async () => {
  const { event, invoke } = fixture(async () => { throw Object.assign(new Error(), { code: 'VIP_BROWSER_WINDOW_LIMIT' }); });
  const failure = await invoke(event);
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, 'VIP_BROWSER_WINDOW_LIMIT');
  assert.equal(failure.error.retryable, true);
  const unavailable = fixture(async () => null);
  assert.equal((await unavailable.invoke(unavailable.event)).error.code, 'VIP_SHOP_OPEN_FAILED');
});

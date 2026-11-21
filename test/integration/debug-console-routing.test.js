const test = require('node:test');
const assert = require('node:assert/strict');

const { createAppConsoleBridge } = require('../../src/app/backend/runtime/app-console');
const { appContext } = require('../../src/app/backend/runtime/app-context');
const { registerHomeConsoleIpc } = require('../../src/app/backend/features/window/register-home-console-ipc');
const { executeHttpRequest } = require('../../src/app/backend/lib/http-client/transport-request');
const {
  isClashMiniNetworkRequestLog,
} = require('../../src/app/backend/ipc/register/clash-mini-core');

test('console snapshots are bounded and skip transferring unchanged entries', () => {
  const bridge = createAppConsoleBridge({ enabled: true, historyLimit: 2 });
  bridge.pushDebugOnly('warn', ['[Clash Mini] [TCP] dial DIRECT timeout']);
  const initial = bridge.getSnapshot();
  assert.equal(initial.history[0].source, 'Clash Mini');
  assert.deepEqual(bridge.getSnapshot(initial.revision), { revision: initial.revision });
  bridge.pushDebugOnly('info', ['[HTTP] request']);
  bridge.pushDebugOnly('warn', ['[Clash Mini] second request']);
  assert.deepEqual(bridge.getSnapshot(initial.revision).history.map(({ source }) => source), ['HTTP', 'Clash Mini']);
  const production = createAppConsoleBridge({ enabled: false });
  production.pushDebugOnly('warn', ['[HTTP] request']);
  assert.deepEqual(production.getSnapshot().history, []);
});

test('clearing the diagnostic buffer advances its revision and keeps accepting new logs', () => {
  const bridge = createAppConsoleBridge({ enabled: true });
  bridge.pushDebugOnly('info', ['[Fixture] before clear']);
  const previous = bridge.getSnapshot();
  bridge.clearHistory();
  const cleared = bridge.getSnapshot(previous.revision);
  assert.ok(cleared.revision > previous.revision);
  assert.deepEqual(cleared.history, []);
  bridge.pushDebugOnly('info', ['[Fixture] after clear']);
  assert.deepEqual(bridge.getSnapshot(cleared.revision).history.map(({ text }) => text), ['[Fixture] after clear']);
});

test('console history is available only to the development shell main frame', () => {
  const mainFrame = { url: 'file:///C:/app/src/app/frontend/views/app-shell.html?dev=1' };
  const contents = { isDestroyed: () => false, mainFrame };
  let reads = 0;
  let clears = 0;
  const register = (isDevMode) => {
    const handlers = new Map();
    registerHomeConsoleIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
      isDevMode,
      getMainWindow: () => ({ webContents: contents }),
      getConsoleSnapshot: (revision) => { reads += 1; return { revision, history: [] }; },
      clearConsoleHistory: () => { clears += 1; return { revision: 8, history: [] }; },
    });
    return { read: handlers.get('get-app-console-history'), clear: handlers.get('clear-app-console-history') };
  };
  const event = { sender: contents, senderFrame: mainFrame };
  const { read, clear } = register(true);
  const production = register(false);
  assert.equal(production.read(event, 0).error.code, 'DEV_MODE_REQUIRED');
  assert.equal(production.clear(event).error.code, 'DEV_MODE_REQUIRED');
  assert.equal(clear({ ...event, sender: {} }).ok, false);
  assert.equal(read({ ...event, sender: {} }, 0).ok, false);
  assert.equal(read({ ...event, senderFrame: { ...mainFrame } }, 0).ok, false);
  assert.deepEqual(read(event, 7), { ok: true, data: { revision: 7, history: [] } });
  assert.deepEqual(clear(event), { ok: true, data: { revision: 8, history: [] } });
  mainFrame.url = 'file:///C:/app/src/app/frontend/sidebar/ai-control.html?dev=1';
  assert.equal(read(event, 0).ok, false);
  assert.equal(clear(event).ok, false);
  assert.equal(reads, 1);
  assert.equal(clears, 1);
});

test('HTTP diagnostics keep the request origin without logging the full URL', async (t) => {
  const bridge = createAppConsoleBridge({ enabled: true });
  const previous = appContext.getDebugConsoleWrite();
  t.after(() => appContext.setDebugConsoleWrite(previous));
  appContext.setDebugConsoleWrite(bridge.pushDebugOnly);
  const result = await executeHttpRequest({
    getServerBase: () => 'https://fixture.test',
    method: 'GET',
    path: '/fixture-id?value=fixture-only',
    getJson: async () => ({ ok: true }),
  });
  assert.equal(result.requestUrl, 'https://fixture.test/fixture-id?value=fixture-only');
  assert.equal(bridge.getSnapshot().history[0].text, '[HTTP] 请求目标: GET https://fixture.test');
});

test('only Mihomo network request stream lines use the exclusive debug route', () => {
  assert.equal(isClashMiniNetworkRequestLog(
    'time="2026-07-15" level=info msg="[TCP] 127.0.0.1:1 --> example.com:443"',
    { stream: 'stdout' },
  ), true);
  assert.equal(isClashMiniNetworkRequestLog(
    'time="2026-07-15" level=info msg="[UDP] 127.0.0.1:1 --> 8.8.8.8:53"',
    { stream: 'stdout' },
  ), true);
  assert.equal(isClashMiniNetworkRequestLog('Clash Meta started', { stream: 'stdout' }), false);
  assert.equal(isClashMiniNetworkRequestLog('[TCP] lifecycle text without child stream', {}), false);
});

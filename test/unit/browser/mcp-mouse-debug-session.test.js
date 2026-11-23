'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMcpMouseDebugSession } = require('../../../src/app/backend/features/browser/mcp-mouse-debug-session');

const fixtureUrl = 'http://127.0.0.1:8000/__ai-free-mcp-debug/12345678123456781234567812345678';
const localUrl = 'http://localhost:3000/custom-test';
const firstClick = { action: 'click', x: .15, y: .3, viewWidth: 800, viewHeight: 600 };

function harness() {
  const calls = [];
  const background = {};
  const active = { 'native:a': { url: fixtureUrl, pageToken: 'one' }, 'native:b': { url: localUrl, pageToken: 'two' } };
  const connections = [{ id: 'native:a', profileId: 'a', browserProcessId: 1 }, { id: 'native:b', profileId: 'b', browserProcessId: 2 }];
  const live = { takeover: false, width: 800, height: 600, failure: null };
  const session = createMcpMouseDebugSession({
    fixtureUrl,
    bridge: {
      listConnections: () => connections,
      listBrowserRecords: () => [{ tabId: 'b' }, { tabId: 'a' }],
      getConnection: (id) => connections.find((browser) => browser.id === id),
      async dispatch(id, tool, data, options = {}) {
        calls.push({ id, tool, data, token: options.expectedPageToken });
        if (tool === 'browser_tab') return { activeTab: active[id], tabs: [active[id], background[id]].filter(Boolean) };
        if (options.expectedPageToken && options.expectedPageToken !== active[id].pageToken) {
          return { success: false, errorCode: 'BROWSER_TARGET_CHANGED' };
        }
        if (tool === 'browser_control') {
          if (data.action !== 'status') live.takeover = data.action === 'acquire';
          return { success: true, takeoverActive: live.takeover };
        }
        if (tool === 'browser_observe') return { success: true, url: active[id].url, viewport: { width: live.width, height: live.height }, dataUrl: 'data:image/png;base64,AA' };
        if (tool === 'browser_action') return live.failure || { success: true, action: data.action };
        throw new Error('Unexpected tool');
      },
    },
    runtime: { async openForegroundTab(profileId, _kind, url) {
      const id = connections.find((browser) => browser.profileId === profileId).id;
      if (background[id]?.url === url) active[id] = background[id];
      return { result: { url } };
    } },
  });
  return { session, calls, active, background, live };
}

test('dispatches an HTTPS website through the shared MCP service with one bound click', async () => {
  const { session, calls, active } = harness();
  const url = 'https://panel.example.test/click';
  active['native:b'].url = url;
  const frame = await session.start();
  assert.equal(frame.url, url);
  assert.equal(frame.viewWidth, 800);
  assert.equal((await session.input(firstClick)).dispatched, 'click');
  assert.deepEqual(calls.find(({ tool }) => tool === 'browser_action'), {
    id: 'native:b', tool: 'browser_action', token: 'two', data: { action: 'click', x: 120, y: 180, after: 'none' },
  });
  assert.equal(calls.find(({ data }) => data.action === 'acquire').token, 'two');
  await session.stop();
  assert.equal(calls.at(-1).data.action, 'release');
});

test('skips internal pages and releases the website session when its document changes', async () => {
  const { session, calls, active } = harness();
  active['native:b'].url = 'chrome://settings/';
  active['native:a'].url = 'http://panel.example.test/click';
  await session.start();
  assert.equal(calls.find(({ data }) => data.action === 'acquire').id, 'native:a');
  active['native:a'] = { url: 'https://another.example.test/', pageToken: 'new' };
  await assert.rejects(session.input(firstClick), { code: 'BROWSER_TARGET_CHANGED' });
  assert.equal(calls.some(({ tool }) => tool === 'browser_action'), false);
  assert.equal(calls.at(-1).data.action, 'release');
  await assert.rejects(session.frame(), { code: 'MCP_DEBUG_NOT_RUNNING' });
});

test('can target the built-in fixture after another tab is selected', async () => {
  const { session, calls, background } = harness();
  background['native:b'] = { url: fixtureUrl, pageToken: 'background' };
  await session.start('fixture');
  assert.equal(calls.find(({ data }) => data.action === 'acquire').token, 'background');
  await session.stop();
});

test('a resized viewport rejects stale coordinates and a failed tool result is never replayed', async () => {
  const { session, calls, live } = harness();
  await session.start();
  live.width = 720;
  await assert.rejects(session.input(firstClick), { code: 'MCP_DEBUG_INPUT_STALE' });
  assert.equal(calls.some(({ tool }) => tool === 'browser_action'), false);
  live.failure = { success: false, errorCode: 'TARGET_NOT_FOUND', error: 'missing', actionExecuted: false };
  await assert.rejects(session.input({ ...firstClick, viewWidth: 720 }), { code: 'TARGET_NOT_FOUND' });
  assert.equal(calls.filter(({ tool }) => tool === 'browser_action').length, 1);
});

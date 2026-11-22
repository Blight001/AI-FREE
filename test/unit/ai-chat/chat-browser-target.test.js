'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { resolveConnections } = require('../../../src/app/backend/features/ai-chat/chat-request-context');
const { captureChatTarget } = require('../../../src/app/backend/features/ai-chat/chat-browser-target');
const { CONFIRMED_UPLOAD_FILES } = require('../../../src/app/backend/browser-runtime/chromium-upload-staging');
const { dispatchChatUpload } = require('../../../src/app/backend/features/ai-chat/chat-browser-upload');

test('an explicitly selected offline browser is never silently replaced', () => {
  const bridge = { listConnections: () => [{ id: 'other' }], getConnection: (id) => ({ id }) };
  assert.equal(resolveConnections({ browserAutomationBridge: bridge }, { localInteraction: true, connectionIds: ['missing'] }).error?.ok, false);
  assert.equal(resolveConnections({ browserAutomationBridge: bridge }, {}).controlledConnectionId, 'other');
});

test('capturing a target requires native page identity, not a tab index', async () => {
  const info = { activeTab: { id: '1', title: '素材页', url: 'https://example.test/path?secret=local' } };
  const bridge = { getConnection: () => ({ name: 'Browser A' }), dispatch: async () => info };
  assert.equal((await captureChatTarget(bridge, 'a')).ok, false);
  info.activeTab.pageToken = 'opaque-page';
  const result = await captureChatTarget(bridge, 'a');
  assert.deepEqual(result.data, {
    connectionId: 'a', pageToken: 'opaque-page', url: info.activeTab.url, title: '素材页', host: 'example.test', browserName: 'Browser A',
  });
});

test('local chat chooses a connection with no manual binding and retains the page it observed', async () => {
  const { dispatchPluginTool } = require('../../../src/app/backend/features/ai-chat/chat-tool-executor');
  const connections = [{ id: 'a' }, { id: 'b' }];
  const tabs = { a: 'a-page', b: 'b-original' };
  const pageCalls = [];
  const bridge = {
    getConnection: (id) => connections.find((connection) => connection.id === id),
    dispatch: async (id, tool, args, { expectedPageToken } = {}) => {
      if (tool === 'browser_tab' && args.action === 'list') return { activeTab: { pageToken: tabs[id] } };
      pageCalls.push({ id, tool, expectedPageToken });
      return expectedPageToken === tabs[id] ? { success: true } : { success: false, errorCode: 'BROWSER_TARGET_CHANGED' };
    },
  };
  const makeTurn = () => ({ localInteraction: true, browserTargets: new Map(), connections, bridge, browserControl: { connectionId: '' },
    describeConnections: () => 'a, b', waitForAbort: async (value) => value });
  const turn = makeTurn();
  const listed = await dispatchPluginTool(turn, 'browser_tab', { action: 'list', change_browser: 'b' });
  assert.equal(listed.activeTab.pageToken, undefined);
  assert.equal((await dispatchPluginTool(turn, 'browser_observe', {})).success, true);
  tabs.b = 'b-reloaded';
  assert.equal((await dispatchPluginTool(turn, 'browser_action', { action: 'click' })).errorCode, 'BROWSER_TARGET_CHANGED');
  assert.equal((await dispatchPluginTool(turn, 'browser_observe', {})).success, true);
  assert.equal((await dispatchPluginTool(turn, 'browser_action', { action: 'click' })).success, true);
  assert.deepEqual(pageCalls.map(({ id, expectedPageToken }) => [id, expectedPageToken]), [
    ['b', 'b-original'], ['b', 'b-original'], ['b', 'b-reloaded'], ['b', 'b-reloaded'],
  ]);
});

test('an explicit tab switch allows the next page, while an unexpected tab change is refused', async () => {
  const { dispatchPluginTool } = require('../../../src/app/backend/features/ai-chat/chat-tool-executor');
  const browser = { id: 'a' };
  let active = { url: 'https://local.test/a', pageToken: 'a-page' };
  const pageCalls = [];
  const context = { localInteraction: true, browserTargets: new Map(), connections: [browser],
    describeConnections: () => browser.id, waitForAbort: async (value) => value,
    bridge: { getConnection: () => browser, async dispatch(_id, tool, args, options) {
      if (tool === 'browser_tab' && args.action === 'list') return { activeTab: active };
      if (tool === 'browser_tab' && args.action === 'switch') return { success: true, url: 'https://local.test/b' };
      pageCalls.push(options.expectedPageToken);
      return { success: true };
    } },
  };
  await dispatchPluginTool(context, 'browser_observe', {});
  assert.equal((await dispatchPluginTool(context, 'browser_tab', { action: 'switch', tab_id: 1 })).success, true);
  assert.equal((await dispatchPluginTool(context, 'browser_action', { action: 'click' })).errorCode, 'BROWSER_TARGET_CHANGED');
  active = { url: 'https://local.test/b', pageToken: 'b-page' };
  assert.equal((await dispatchPluginTool(context, 'browser_observe', {})).success, true);
  assert.deepEqual(pageCalls, ['a-page', 'b-page']);
});

test('the sidebar can take over a browser showing a new tab without a webpage token', async () => {
  const { dispatchPluginTool } = require('../../../src/app/backend/features/ai-chat/chat-tool-executor');
  const browser = { id: 'a' };
  const context = { localInteraction: true, browserTargets: new Map(), connections: [browser],
    describeConnections: () => browser.id, waitForAbort: async (value) => value,
    bridge: { getConnection: () => browser, async dispatch(_id, tool, args, options) {
      if (tool === 'browser_tab') return { activeTab: { url: 'chrome://new-tab-page/' } };
      assert.equal(tool, 'browser_control');
      assert.equal(args.action, 'acquire');
      assert.equal(options.expectedPageToken, undefined);
      return { success: true, takeoverActive: true };
    } },
  };
  assert.equal((await dispatchPluginTool(context, 'browser_control', { action: 'acquire' })).takeoverActive, true);
});

test('the local sidebar reloads a selected tab and binds input to the new document', async () => {
  const { dispatchPluginTool } = require('../../../src/app/backend/features/ai-chat/chat-tool-executor');
  const browser = { id: 'a', name: '浏览器功能测试' };
  const url = 'https://local.test/a';
  let pageToken = 'before-reload';
  const context = { localInteraction: true, browserTargets: new Map(), connections: [browser],
    describeConnections: () => browser.name, waitForAbort: async (value) => value,
    bridge: { getConnection: () => browser, async dispatch(_id, tool, args, options) {
      if (tool === 'browser_tab' && args.action === 'list') return { activeTab: { url, pageToken } };
      if (tool === 'browser_tab' && args.action === 'reload') {
        assert.equal(args.tab_id, 1);
        pageToken = 'after-reload';
        return { success: true, url };
      }
      assert.equal(options.expectedPageToken, pageToken);
      return { success: true };
    } },
  };
  assert.equal((await dispatchPluginTool(context, 'browser_observe', {})).success, true);
  assert.equal((await dispatchPluginTool(context, 'browser_tab', {
    action: 'reload', tab_id: 1, change_browser: browser.name,
  })).success, true);
  assert.equal((await dispatchPluginTool(context, 'browser_observe', {})).success, true);
  assert.equal((await dispatchPluginTool(context, 'browser_action', { action: 'click', selector: '#go' })).success, true);
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVbcAAAAASUVORK5CYII=', 'base64');

function uploadContext(t, contents = PNG) {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-upload-check-'));
  const file = path.join(workspaceDir, 'tile.png');
  fs.writeFileSync(file, contents);
  t.after(() => {
    for (const entry of fs.readdirSync(workspaceDir)) fs.unlinkSync(path.join(workspaceDir, entry));
    fs.rmdirSync(workspaceDir);
  });
  return {
    workspaceDir, uploadState: { unverified: false }, boundTarget: { connectionId: 'a', pageToken: 'page' },
    bridge: { getConnection: () => ({ id: 'a', name: 'A' }), dispatch: async () => ({ activeTab: { pageToken: 'page' } }) },
  };
}

test('an image upload goes straight to the bound page with a verified file snapshot', async (t) => {
  const context = uploadContext(t);
  const result = await dispatchChatUpload(context, 'a', { path: 'tile.png', selector: '#reference' }, async (args) => {
    const [snapshot] = args[CONFIRMED_UPLOAD_FILES];
    assert.deepEqual(args.paths, [path.join(context.workspaceDir, 'tile.png')]);
    assert.equal(snapshot.absolutePath, args.paths[0]);
    assert.equal(snapshot.size, PNG.length);
    assert.match(snapshot.sha256, /^[a-f0-9]{64}$/);
    assert.equal(args.selector, '#reference');
    return { success: true };
  });
  assert.equal(result.uploadVerification, 'file_selected');
});

test('JSON and mixed uploads go straight to the bound page with verified snapshots', async (t) => {
  const context = uploadContext(t);
  const json = '{"theme":"dark"}';
  fs.writeFileSync(path.join(context.workspaceDir, 'profile.json'), json);
  for (const paths of [['profile.json'], ['tile.png', 'profile.json']]) {
    const result = await dispatchChatUpload(context, 'a', { paths }, async (args) => {
      const snapshots = args[CONFIRMED_UPLOAD_FILES];
      assert.deepEqual(snapshots.map((snapshot) => snapshot.path), paths);
      assert.equal(snapshots.at(-1).size, Buffer.byteLength(json));
      return { success: true };
    });
    assert.equal(result.uploadVerification, 'file_selected');
  }
});

test('upload rejects a stale browser target before dispatch', async (t) => {
  const context = uploadContext(t);
  context.boundTarget.pageToken = 'old-document';
  const result = await dispatchChatUpload(context, 'a', { path: 'tile.png' }, () => assert.fail('must not dispatch'));
  assert.equal(result.errorCode, 'BROWSER_TARGET_CHANGED');
});

test('stopped uploads and changed artifacts do not reach dispatch', async (t) => {
  const context = uploadContext(t);
  const dispatch = () => assert.fail('must not dispatch');
  const controller = new AbortController();
  controller.abort();
  const cancelled = await dispatchChatUpload({ ...context, signal: controller.signal }, 'a', { path: 'tile.png' }, dispatch);
  assert.equal(cancelled.errorCode, 'UPLOAD_CANCELLED');
  assert.equal(cancelled.actionExecuted, false);
  const reference = { path: 'tile.png', size: PNG.length, sha256: '0'.repeat(64), kind: 'image' };
  const changed = await dispatchChatUpload({ ...context, artifactReferences: [reference] }, 'a', { path: reference.path }, dispatch);
  assert.equal(changed.errorCode, 'UPLOAD_NOT_READY');
  assert.equal(changed.actionExecuted, false);
});

test('lost upload receipt marks verification required without a second dispatch', async (t) => {
  const context = uploadContext(t);
  let calls = 0;
  const result = await dispatchChatUpload(context, 'a', { path: 'tile.png', page_url: 'https://wrong.test' }, async (args) => {
    calls += 1;
    assert.equal(args.page_url, undefined);
    assert.deepEqual(args.paths, [path.join(context.workspaceDir, 'tile.png')]);
    throw new Error('lost acknowledgement');
  });
  assert.equal(calls, 1);
  assert.equal(result.errorCode, 'UPLOAD_OUTCOME_UNVERIFIED');
  assert.equal(context.uploadState.unverified, true);
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createRemoteBrowserControl,
  fetchIceServers,
  normalizeAddress,
  normalizeTabs,
} = require('../../../src/app/main/features/browser/remote-browser-control');

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function fixture() {
  const automation = [];
  const inputs = [];
  const peerCalls = [];
  const signals = [];
  const runtime = {
    getState: () => ({ pid: 42, bridgeConnected: true }),
    dispatchAutomationByProcessId: async (_pid, command, input) => {
      automation.push([command, input]);
      if (command === 'capture-screenshot') {
        return { result: { dataUrl: 'data:image/png;base64,FRAME' } };
      }
      if (command === 'list-tabs') {
        return { result: { activeTabId: 3, tabs: [{ id: 3, title: 'Page', url: 'https://example.test' }] } };
      }
      return { result: { success: true } };
    },
    dispatchInput: async (_profileId, input) => inputs.push(input),
    navigate: async (...args) => automation.push(['navigate', args]),
    openTabs: async (...args) => automation.push(['openTabs', args]),
    reload: async (...args) => automation.push(['reload', args]),
  };
  const peer = {
    start: async (...args) => peerCalls.push(['start', ...args]),
    answer: async (...args) => peerCalls.push(['answer', ...args]),
    ice: async (...args) => peerCalls.push(['ice', ...args]),
    frame: async (...args) => peerCalls.push(['frame', ...args]),
    browserState: async (...args) => peerCalls.push(['browserState', ...args]),
    stop: async () => peerCalls.push(['stop']),
  };
  const control = createRemoteBrowserControl({
    browserRuntimeManager: runtime,
    getActiveProfileId: () => 'profile-1',
    peer,
    fetch: async () => ({ ok: true, json: async () => ({ ice_servers: [{ urls: 'turn:test' }] }) }),
    sendSignal: (event, payload) => signals.push([event, payload]),
  });
  return { control, automation, inputs, peerCalls, signals };
}

test('远程浏览器会话建立 WebRTC、采集活动 Chromium 并回传标准信令', async () => {
  const state = fixture();
  assert.equal(await state.control.start({ sessionId: 'rc-1', qualityPreset: 'smooth' }, {
    server: 'https://heysure.example', token: 'token',
  }), true);
  state.control.handlePeerMessage({ event: 'offer', sessionId: 'rc-1', sdp: 'offer' });
  state.control.handlePeerMessage({ event: 'ready', sessionId: 'rc-1', width: 1280, height: 720 });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(state.peerCalls[0], ['start', 'rc-1', [{ urls: 'turn:test' }]]);
  assert.equal(state.peerCalls.some((call) => call[0] === 'browserState'), true);
  assert.equal(state.peerCalls.some((call) => call[0] === 'frame'), true);
  assert.deepEqual(state.signals, [
    ['rc:offer', { sessionId: 'rc-1', sdp: 'offer' }],
    ['rc:ready', { sessionId: 'rc-1', width: 1280, height: 720, rotation: 0 }],
  ]);
  await state.control.stop('test_end', false);
  assert.equal(state.automation.some(([command, input]) => (
    command === 'automation-takeover' && input.action === 'release'
  )), true);
});

test('远程指针、文字和浏览器地址命令复用 Chromium 原生控制入口', async () => {
  const state = fixture();
  await state.control.start({ sessionId: 'rc-input' }, { server: 'https://server', token: 'token' });
  state.control.handlePeerMessage({ event: 'ready', sessionId: 'rc-input', width: 1000, height: 500 });
  state.control.handlePeerMessage({ event: 'control', sessionId: 'rc-input', message: {
    type: 'down', x: 0.25, y: 0.5, button: 'left',
  } });
  state.control.handlePeerMessage({ event: 'control', sessionId: 'rc-input', message: {
    type: 'up', x: 0.25, y: 0.5, button: 'left',
  } });
  state.control.handlePeerMessage({ event: 'control', sessionId: 'rc-input', message: {
    type: 'text', text: '中文输入',
  } });
  state.control.handlePeerMessage({ event: 'control', sessionId: 'rc-input', message: {
    kind: 'browser', action: 'navigate', url: 'example.com',
  } });
  await tick();
  await state.control.session.inputTask;

  assert.equal(state.inputs.length, 1);
  assert.deepEqual(state.inputs[0], {
    inputType: 'mouse', action: 'click', x: 250, y: 250,
    viewportWidth: 1000, viewportHeight: 500,
  });
  assert.equal(state.automation.some(([command, input]) => (
    command === 'perform-action' && input.action === 'insert_text' && input.text === '中文输入'
  )), true);
  assert.equal(state.automation.some(([command, args]) => (
    command === 'navigate' && args[2] === 'https://example.com'
  )), true);
  await state.control.stop('test_end', false);
});

test('远程浏览器协议辅助函数规范化地址、标签与 ICE 回退', async () => {
  assert.equal(normalizeAddress('hello world'), 'https://www.bing.com/search?q=hello%20world');
  assert.deepEqual(normalizeTabs({ activeTabId: 2, tabs: [{ id: 2, url: 'https://a.test' }] }).tabs[0], {
    id: 0, title: 'https://a.test', url: 'https://a.test', favIconUrl: '', active: true, index: 0,
  });
  const fallback = await fetchIceServers(async () => ({ ok: false }), 'https://server', 'token');
  assert.match(String(fallback[0].urls), /^stun:/);
});

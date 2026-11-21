'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createBrowserAppPointer } = require('../../../src/app/backend/features/browser/browser-app-pointer');

function fixture(overrides = {}) {
  const events = [];
  let focused = true;
  let point = { x: 90, y: 60, label: '选择模型' };
  let url = 'file:///app/src/app/frontend/sidebar/ai-control.html';
  const contents = {
    mainFrame: {}, isDestroyed: () => false, isLoadingMainFrame: () => false, getURL: () => url,
    async executeJavaScriptInIsolatedWorld(_world, [{ code }]) {
      if (code.includes('function readControl')) return code.endsWith('("ai-chat-model-trigger")') ? point : null;
      if (code.includes('function drawPointer')) events.push('draw');
      else events.push('hide');
    },
    getZoomFactor: () => 1,
    focus: () => events.push('focus'),
    sendInputEvent: (event) => events.push(event.type),
  };
  const win = { isDestroyed: () => false, isVisible: () => true, isFocused: () => focused, getChildWindows: () => [] };
  const adapter = createBrowserAppPointer({
    getMainWindow: () => win, getSideView: () => ({ webContents: contents, getBounds: () => ({ x: 100, y: 0 }) }),
    getIsSidebarVisible: () => true, getActiveProfileId: () => 'profile',
    ...overrides,
  });
  return { events, adapter, unfocus: () => { focused = false; },
    move: () => { point = { ...point, x: 95 }; }, navigate: (next) => { url = next; } };
}

test('the app pointer moves before dispatching a real Electron input sequence', async () => {
  const { adapter, events } = fixture();
  const observed = await adapter.observe('profile', 'sidebar');
  assert.deepEqual(observed.items, [{ ref: 'ai-chat-model-trigger', label: '选择模型' }]);
  const state = { position: null };
  const result = await adapter.click('profile', 'sidebar', observed.items[0].ref, state, new AbortController().signal);
  assert.equal(result.actionExecuted, true);
  assert.equal(events[0], 'draw');
  assert.deepEqual(events.slice(-5), ['focus', 'mouseMove', 'mouseDown', 'mouseUp', 'hide']);
  assert.equal(state.position.x, 90);
});

test('the app pointer stops when its target moves during animation', async () => {
  const { adapter, events, move } = fixture();
  const work = adapter.click('profile', 'sidebar', 'ai-chat-model-trigger', { position: null }, new AbortController().signal);
  await Promise.resolve();
  move();
  const result = await work;
  assert.equal(result.errorCode, 'APP_CONTROL_MOVED');
  assert.equal(events.includes('mouseDown'), false);
  assert.equal(events.at(-1), 'hide');
});

test('the sidebar shares the native overlay and verifies hit testing before input', async () => {
  const observations = [];
  const { adapter, events } = fixture({
    toScreenPoint: (point, offset) => ({ x: point.x + offset.x + 200, y: point.y + offset.y + 100 }),
    overlayFor: () => ({
      move: (point, pointer) => { observations.push(point); pointer.screenPoint = point; return true; },
      hit: () => false,
      hide: () => observations.push('hide'),
    }),
  });
  const result = await adapter.click('profile', 'sidebar', 'ai-chat-model-trigger', {}, new AbortController().signal);
  assert.equal(result.errorCode, 'APP_CONTROL_MOVED');
  assert.deepEqual(observations, [{ x: 390, y: 160 }, 'hide']);
  assert.deepEqual(events, []);
});

test('remote documents, other profiles and non-foreground surfaces receive no input', async () => {
  const { adapter, events, navigate, unfocus } = fixture();
  assert.equal((await adapter.observe('another-profile', 'sidebar')).success, false);
  navigate('https://example.test/frontend/sidebar/ai-control.html');
  assert.equal((await adapter.observe('profile', 'sidebar')).success, false);
  navigate('file:///app/src/app/frontend/sidebar/ai-control.html');
  unfocus();
  assert.equal((await adapter.observe('profile', 'sidebar')).success, false);
  assert.deepEqual(events, []);
});

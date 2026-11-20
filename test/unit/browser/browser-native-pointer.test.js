'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createBrowserNativePointer } = require('../../../src/app/backend/features/browser/browser-native-pointer');

function fixture(onFrame = () => {}) {
  const events = [];
  const runtime = {
    getState: () => ({ status: 'ready', browserHwnd: '20', pid: 42 }),
    windowBridge: { browserPointerFrame(input) {
      events.push(input);
      const override = onFrame(input);
      if (override !== undefined) return override;
      if (input.op === 'bounds' || input.op === 'observe') return { x: -100, y: 50, width: 500, height: 200, window: '20' };
      if (input.op === 'target') return '20';
      return true;
    } },
  };
  const adapter = createBrowserNativePointer({
    getMainWindow: () => ({ isDestroyed: () => false, getNativeWindowHandle: () => Buffer.alloc(8) }),
    getActiveProfileId: () => 'profile', runtime,
  });
  const action = (input, pointer, signal) => {
    const { observationId } = adapter.observe('profile', input.surface);
    return adapter.action('profile', { observation_id: observationId, ...input }, pointer, signal);
  };
  return { events, adapter, action };
}

test('native click paints to the destination before sending input and preserves negative monitor coordinates', async () => {
  const { events, action } = fixture();
  const pointer = {};
  const result = await action({ surface: 'chromium', action: 'click', x: 15, y: 20 }, pointer, new AbortController().signal);
  assert.equal(result.success, true);
  const press = events.findIndex(({ op }) => op === 'down');
  const lastDraw = events.findLastIndex(({ op }) => op === 'draw');
  assert.ok(lastDraw < press);
  assert.deepEqual(pointer.screenPoint, { x: -85, y: 70 });
  assert.equal(events[press].expectedHwnd, '20');
  assert.equal(events.at(-1).op, 'hide');
});

test('observed native controls can be clicked by ref and reject a changed label', async () => {
  let label = '新建标签页';
  const { adapter, action, events } = fixture(({ op }) => {
    if (op === 'observe') return { x: -100, y: 50, width: 500, height: 200, window: '20',
      items: [{ role: 'button', label, x: 15, y: 20 }] };
  });
  const observed = adapter.observe('profile', 'chromium');
  const ref = observed.items[0].ref;
  const input = { surface: 'chromium', action: 'click', ref };
  assert.equal((await action(input, {}, new AbortController().signal)).success, true);
  label = '关闭标签页';
  const stale = await adapter.action('profile', { ...input, observation_id: observed.observationId }, {}, new AbortController().signal);
  assert.equal(stale.errorCode, 'NATIVE_POINTER_TARGET_INVALID');
  assert.equal(events.filter(({ op }) => op === 'down').length, 1);
});

test('a replaced file dialog invalidates the observation at the same coordinates', async () => {
  let window = '40';
  const { events, adapter } = fixture(({ op }) => {
    if (op === 'bounds' || op === 'observe') return { x: 0, y: 0, width: 500, height: 200, window };
  });
  const { observationId } = adapter.observe('profile', 'dialog');
  window = '41';
  const result = await adapter.action('profile', {
    surface: 'dialog', action: 'click', x: 15, y: 20, observation_id: observationId,
  }, {}, new AbortController().signal);
  assert.equal(result.errorCode, 'NATIVE_POINTER_OBSERVATION_EXPIRED');
  assert.equal(events.some(({ op }) => op === 'down'), false);
});

test('target replacement during travel cancels input and hides the overlay', async () => {
  let drew = false;
  const { events, action } = fixture(({ op }) => {
    if (op === 'draw') drew = true;
    if (op === 'target' && drew) return '21';
  });
  const result = await action({ surface: 'dialog', action: 'click', x: 15, y: 20 }, {}, new AbortController().signal);
  assert.equal(result.errorCode, 'NATIVE_POINTER_TARGET_CHANGED');
  assert.equal(events.some(({ op }) => op === 'down'), false);
  assert.equal(events.at(-1).op, 'hide');
});

test('popup navigation keys are sent only to the current observed popup', async () => {
  const { events, action } = fixture();
  const result = await action({ surface: 'chromium_popup', action: 'press_key', key: 'ArrowDown', x: 15, y: 20 }, {}, new AbortController().signal);
  assert.equal(result.dispatched, true);
  const key = events.find((event) => event.op === 'key');
  assert.equal(key.expectedHwnd, '20');
  assert.equal(key.key, 'arrowdown');
  assert.equal(key.surface, 'chromium_popup');
});

test('a drag can resolve both tab endpoints from the same observation', async () => {
  const { events, action } = fixture(({ op }) => {
    if (op === 'observe') return { x: -100, y: 50, width: 500, height: 200, window: '20', items: [
      { role: 'tab', label: 'First tab', x: 15, y: 20 },
      { role: 'tab', label: 'Second tab', x: 90, y: 20 },
    ] };
  });
  const result = await action({ surface: 'chromium', action: 'drag', ref: 'native-control-1', to_ref: 'native-control-2' }, {}, new AbortController().signal);
  assert.equal(result.dispatched, true);
  assert.equal(events.find(({ op }) => op === 'down').x, -85);
  assert.equal(events.find(({ op }) => op === 'up').x, -10);
});

test('cancellation during a drag cancels capture at the last delivered point', async () => {
  const controller = new AbortController();
  const { events, action } = fixture(({ op }) => {
    if (op === 'drag') controller.abort();
  });
  const result = await action({ surface: 'chromium', action: 'drag', x: 15, y: 20, to_x: 90, to_y: 20 }, {}, controller.signal);
  assert.equal(result.errorCode, 'NATIVE_POINTER_GESTURE_INTERRUPTED');
  assert.equal(result.actionExecuted, true);
  const drag = events.find(({ op }) => op === 'drag');
  const cancel = events.find(({ op }) => op === 'cancel');
  assert.ok(drag && cancel);
  assert.equal(cancel.x, drag.x);
  assert.equal(cancel.y, drag.y);
  assert.equal(events.some(({ op }) => op === 'up'), false);
});

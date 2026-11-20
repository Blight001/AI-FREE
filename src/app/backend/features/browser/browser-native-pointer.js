'use strict';

const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const NATIVE_SURFACES = new Set(['chromium', 'chromium_popup', 'dialog']);
const NATIVE_KEYS = new Set(['enter', 'escape', 'arrowdown', 'arrowup', 'arrowleft', 'arrowright', 'tab', 'backspace', 'delete']);
const BUTTONS = new Map([
  ['click', ['down', 'up']], ['double_click', ['down', 'up']],
  ['right_click', ['right_down', 'right_up']], ['drag', ['down', 'up']],
]);
const FRAME_MS = 16;

function failure(errorCode, error, actionExecuted = false) {
  return { success: false, errorCode, error, actionExecuted };
}

function pointIn(bounds, x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return null;
  return { x: bounds.x + x, y: bounds.y + y };
}

function resolvePoint(frame, bounds, snapshot, input) {
  const { ref } = input;
  if (!ref) return pointIn(bounds, input.x, input.y);
  const item = snapshot.bounds.items.find((entry) => entry.ref === ref);
  if (!item) return null;
  const current = frame('observe');
  if (!sameBounds(bounds, current) || !Array.isArray(current.items)) return null;
  const matches = current.items.filter((entry) => entry.role === item.role && entry.label === item.label
    && entry.x === item.x && entry.y === item.y);
  return matches.length === 1 ? pointIn(bounds, item.x, item.y) : null;
}

function sameBounds(a, b) {
  return !!b && ['window', 'x', 'y', 'width', 'height'].every((key) => a[key] === b[key]);
}

function validSnapshot(snapshot, profileId, surface, bounds) {
  return snapshot && snapshot.profileId === profileId && snapshot.surface === surface
    && snapshot.expires >= Date.now() && sameBounds(snapshot.bounds, bounds);
}

function resolveDragEnd(frame, bounds, snapshot, input, point) {
  if (input.action !== 'drag') return point;
  return resolvePoint(frame, bounds, snapshot, { ref: input.to_ref, x: input.to_x, y: input.to_y });
}

function createBrowserNativePointer({ getMainWindow, getActiveProfileId, runtime }) {
  function scope(profileId, surface) {
    if (getActiveProfileId() !== profileId) return null;
    const main = getMainWindow();
    const state = runtime.getState(profileId);
    if (!main || main.isDestroyed() || state?.status !== 'ready' || !state.browserHwnd) return null;
    const options = { rootHwnd: main.getNativeWindowHandle(), browserHwnd: state.browserHwnd, browserPid: state.pid, surface };
    return (op, payload) => runtime.windowBridge.browserPointerFrame({ ...options, op, ...payload });
  }

  const snapshots = new Map();

  function remember(profileId, surface, bounds) {
    const id = randomUUID();
    snapshots.set(id, { profileId, surface, bounds, expires: Date.now() + 30000 });
    if (snapshots.size > 32) snapshots.delete(snapshots.keys().next().value);
    return id;
  }

  function observe(profileId, surface) {
    const frame = NATIVE_SURFACES.has(surface) && scope(profileId, surface);
    const bounds = frame && frame('observe');
    if (!bounds) return failure('NATIVE_POINTER_UNAVAILABLE', '目标原生界面当前不可操作，请检查前台窗口和原生模块版本。');
    const items = Array.isArray(bounds.items) ? bounds.items.filter((item) => {
      const point = pointIn(bounds, item.x, item.y);
      return point && frame('target', point);
    }).map((item, index) => ({ ...item, ref: `native-control-${index + 1}` })) : [];
    const observationId = remember(profileId, surface, { ...bounds, items });
    return { success: true, surface, width: bounds.width, height: bounds.height, items,
      observationId, coordinateSpace: 'surface_physical_pixels' };
  }

  /** @param {(point: {x: number, y: number}) => boolean} [move] */
  async function animate(frame, point, pointer, signal, check, move = () => true) {
    const previous = pointer.screenPoint;
    const nearby = { x: point.x - 28, y: point.y - 18 };
    const start = [previous, nearby].find((candidate) => candidate && frame('visible', candidate)) || point;
    for (let index = 1; index <= 12; index += 1) {
      if (signal.aborted || !check()) return false;
      const t = index / 12;
      const eased = t * t * (3 - 2 * t);
      const next = { x: Math.round(start.x + (point.x - start.x) * eased), y: Math.round(start.y + (point.y - start.y) * eased) };
      if (!frame('draw', next) || !move(next)) return false;
      pointer.screenPoint = next;
      await delay(FRAME_MS);
    }
    return !signal.aborted && check();
  }

  async function action(profileId, input, pointer, signal) {
    const frame = NATIVE_SURFACES.has(input.surface) ? scope(profileId, input.surface) : null;
    const bounds = frame?.('bounds');
    if (!bounds) return failure('NATIVE_POINTER_UNAVAILABLE', '目标原生界面当前不可操作。');
    const snapshot = snapshots.get(input.observation_id);
    if (!validSnapshot(snapshot, profileId, input.surface, bounds)) {
      return failure('NATIVE_POINTER_OBSERVATION_EXPIRED', '窗口已移动、关闭或切换，请重新观察。');
    }
    const point = resolvePoint(frame, bounds, snapshot, input);
    const target = point && frame('target', point);
    if (!target) return failure('NATIVE_POINTER_TARGET_INVALID', '坐标未命中指定界面，或目标被遮挡。');
    const sameTarget = (p) => getActiveProfileId() === profileId && sameBounds(bounds, frame('bounds')) && frame('target', p) === target;
    const send = (op, p, extra) => (op === 'cancel' || sameTarget(p))
      && frame(op, { ...p, expectedHwnd: target, ...extra });
    try {
      if (!await animate(frame, point, pointer, signal, () => sameTarget(point))) return failure('NATIVE_POINTER_TARGET_CHANGED', '目标在光标移动期间发生变化。');
      if (!resolvePoint(frame, bounds, snapshot, input) || !sameTarget(point) || signal.aborted) {
        return failure('NATIVE_POINTER_TARGET_CHANGED', '控件已移动、隐藏或不再唯一，请重新观察。');
      }
      const drag = (end, move) => animate(frame, end, pointer, signal, () => sameTarget(end), move);
      const end = resolveDragEnd(frame, bounds, snapshot, input, point);
      return await dispatch(input, point, end, send, drag, signal);
    } finally {
      frame('hide');
    }
  }

  function overlayFor(profileId) {
    const frame = scope(profileId, 'overlay');
    if (!frame?.('bounds')) return null;
    return {
      move: (point, pointer, signal, check) => animate(frame, point, pointer, signal, check),
      hit: (point) => frame('app_hit', point),
      hide: () => frame('hide'),
    };
  }

  return { observe, action, overlayFor };
}

async function dispatch(input, point, end, send, animateDrag, signal) {
  const { action } = input;
  let sent;
  if (action === 'scroll') {
    const amount = Math.min(1200, Math.max(1, Math.round(Number(input.amount) || 120)));
    sent = send('wheel', point, { delta: input.direction === 'up' ? amount : -amount });
  } else if (action === 'type') {
    sent = send('text', point, { text: input.text });
  } else if (action === 'press_key') {
    const key = String(input.key || '').toLowerCase();
    sent = NATIVE_KEYS.has(key) && send('key', point, { key });
  } else if (BUTTONS.has(action)) {
    return dispatchGesture(input, point, end, send, animateDrag, signal);
  }
  return sent ? { success: true, dispatched: true } : failure('NATIVE_POINTER_INPUT_FAILED', '目标没有接受该输入。');
}

async function dispatchGesture(input, point, end, send, animateDrag, signal) {
  const [down, up] = BUTTONS.get(input.action);
  if (!end || !send('move', point) || !send(down, point)) return failure('NATIVE_POINTER_INPUT_FAILED', '目标未接受按压。');
  let reached = point;
  let completed = false;
  let released = false;
  try {
    await delay(55);
    if (!signal.aborted) {
      completed = end === point || await animateDrag(end, (next) => {
        if (!send('drag', next)) return false;
        reached = next;
        return true;
      });
    }
  } finally {
    if (completed) released = send(up, reached);
    if (!released) send('cancel', reached);
  }
  if (completed && released && input.action === 'double_click') {
    completed = await dispatchSecondClick(send, reached, up, signal);
  }
  return completed && released ? { success: true, dispatched: true }
    : failure('NATIVE_POINTER_GESTURE_INTERRUPTED', '操作途中中断，请重新观察界面状态。', true);
}

async function dispatchSecondClick(send, point, up, signal) {
  await delay(65);
  if (signal.aborted || !send('double_down', point)) return false;
  if (send(up, point)) return true;
  send('cancel', point);
  return false;
}

module.exports = { createBrowserNativePointer, NATIVE_SURFACES };

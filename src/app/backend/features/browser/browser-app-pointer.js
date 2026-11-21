'use strict';

const { setTimeout: delay } = require('node:timers/promises');

const TARGETS = Object.freeze({
  shell: ['home-tab-btn', 'new-browser-window-btn', 'open-default-browser-settings', 'browser-settings-dialog-close'],
  sidebar: ['ai-chat-attach', 'ai-chat-workspace-close', 'ai-chat-model-trigger'],
});
const DELAY_MS = 16;
const MOVE_FRAMES = 12;
const WORLD_ID = 1201;
const APP_POINTER_ACTIONS = new Set(['click', 'double_click', 'right_click', 'scroll']);

// Runs only in the isolated world of an explicitly selected, local app page.
function readControl(id) {
  const node = document.getElementById(id);
  if (!node || node.matches(':disabled, [aria-disabled="true"]')) return null;
  const bounds = node.getBoundingClientRect();
  const x = Math.round(bounds.x + bounds.width / 2);
  const y = Math.round(bounds.y + bounds.height / 2);
  if (!bounds.width || !bounds.height || !node.contains(document.elementFromPoint(x, y))) return null;
  return { x, y, label: node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent.trim() };
}

function validateAppInput(name, ref, action) {
  if (!APP_POINTER_ACTIONS.has(action)) return failure('APP_ACTION_UNSUPPORTED', '此应用界面不支持该动作。');
  if (!Object.hasOwn(TARGETS, name) || !TARGETS[name].includes(ref)) {
    return failure('APP_CONTROL_UNSUPPORTED', '请使用应用界面观察返回的控件。');
  }
  return null;
}

function controlStayedAt(current, x, y) {
  return current?.x === x && current?.y === y;
}

function sameScreenPoint(expected, read) {
  if (!expected) return true;
  const actual = read();
  return actual.x === expected.x && actual.y === expected.y;
}

function startPoint(position, contents, x, y) {
  if (position?.surface === contents) return position;
  return { x: Math.max(0, x - 60), y: Math.max(0, y - 40) };
}

function drawPointer(x, y, pressed) {
  let element = document.getElementById('ai-free-app-action-pointer');
  if (!element) {
    element = document.createElement('span');
    element.id = 'ai-free-app-action-pointer';
    element.setAttribute('aria-hidden', 'true');
    Object.assign(element.style, {
      position: 'fixed', width: '16px', height: '19px', pointerEvents: 'none', zIndex: '2147483647',
    });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '-1 -1 16 19');
    const arrow = document.createElementNS(svg.namespaceURI, 'path');
    arrow.setAttribute('d', 'M0 0 L4 17 L8 11 L14 10 Z');
    arrow.setAttribute('fill', '#fff');
    arrow.setAttribute('stroke', '#145bc4');
    arrow.setAttribute('stroke-width', '1.5');
    svg.appendChild(arrow);
    element.appendChild(svg);
    document.documentElement.appendChild(element);
  }
  Object.assign(element.style, { left: `${x}px`, top: `${y}px`, transformOrigin: 'top left', transform: `scale(${pressed ? 0.88 : 1})` });
}

function hidePointer() {
  document.getElementById('ai-free-app-action-pointer')?.remove();
}

function execute(contents, script, ...args) {
  const code = `(${script.toString()})(${args.map((arg) => JSON.stringify(arg)).join(',')})`;
  return contents.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }]);
}

/** @param {Electron.WebContents} contents */
function sendAppInput(contents, x, y, input) {
  const zoom = contents.getZoomFactor();
  const point = { x: Math.round(x * zoom), y: Math.round(y * zoom) };
  contents.focus();
  contents.sendInputEvent({ ...point, type: 'mouseMove' });
  if (input.action === 'scroll') {
    const amount = Math.min(1200, Math.max(1, Math.round(Number(input.amount) || 120)));
    contents.sendInputEvent({ ...point, type: 'mouseWheel', deltaY: input.direction === 'up' ? amount : -amount });
    return;
  }
  const button = input.action === 'right_click' ? 'right' : 'left';
  const clicks = input.action === 'double_click' ? 2 : 1;
  for (let clickCount = 1; clickCount <= clicks; clickCount += 1) {
    contents.sendInputEvent({ ...point, button, clickCount, type: 'mouseDown' });
    contents.sendInputEvent({ ...point, button, clickCount, type: 'mouseUp' });
  }
}

function failure(errorCode, error) {
  return { success: false, errorCode, error, actionExecuted: false };
}

function isLocalSurface(contents, pageName) {
  if (!contents || contents.isDestroyed() || contents.isLoadingMainFrame()) return false;
  const url = contents.getURL();
  return url.startsWith('file:///') && new URL(url).pathname.endsWith(`/frontend/${pageName}`);
}

/** @param {{getMainWindow: () => Electron.BrowserWindow, getSideView: () => Electron.WebContentsView, getIsSidebarVisible: () => boolean, getActiveProfileId: () => string, overlayFor?: Function, toScreenPoint?: Function}} deps */
function createBrowserAppPointer({ getMainWindow, getSideView, getIsSidebarVisible, getActiveProfileId, overlayFor, toScreenPoint }) {
  function screenPoint(contents, name, x, y) {
    const zoom = contents.getZoomFactor();
    const offset = name === 'sidebar' ? getSideView().getBounds() : { x: 0, y: 0 };
    return toScreenPoint({ x: Math.round(x * zoom), y: Math.round(y * zoom) }, offset);
  }

  async function moveLocal(contents, start, point, check) {
    for (let step = 1; step <= MOVE_FRAMES; step += 1) {
      if (!check()) return false;
      const progress = (step / MOVE_FRAMES) ** 2;
      await execute(contents, drawPointer, start.x + (point.x - start.x) * progress, start.y + (point.y - start.y) * progress, false);
      await delay(DELAY_MS);
    }
    return true;
  }
  function surface(profileId, name) {
    const win = getMainWindow();
    if (!win || win.isDestroyed() || !win.isVisible() || !win.isFocused()) return null;
    if (getActiveProfileId() !== profileId || win.getChildWindows().some((child) => child.isVisible())) return null;
    if (name === 'shell') return isLocalSurface(win.webContents, 'views/app-shell.html') ? win.webContents : null;
    if (name !== 'sidebar' || !getIsSidebarVisible()) return null;
    const contents = getSideView()?.webContents;
    return isLocalSurface(contents, 'sidebar/ai-control.html') ? contents : null;
  }

  async function observe(profileId, name) {
    const contents = surface(profileId, name);
    if (!contents) return failure('APP_SURFACE_UNAVAILABLE', '目标界面当前不可操作。');
    const controls = await Promise.all(TARGETS[name].map(async (ref) => {
      const control = await execute(contents, readControl, ref);
      return control && { ref, label: control.label };
    }));
    return { success: true, surface: name, items: controls.filter(Boolean) };
  }

  async function click(profileId, name, ref, pointer, signal, input = { action: 'click' }) {
    const invalid = validateAppInput(name, ref, input.action);
    if (invalid) return invalid;
    const contents = surface(profileId, name);
    if (!contents) return failure('APP_SURFACE_UNAVAILABLE', '目标界面当前不可操作。');
    const frame = contents.mainFrame;
    const isCurrent = () => !signal.aborted && surface(profileId, name) === contents && contents.mainFrame === frame;
    const point = await execute(contents, readControl, ref);
    if (!point) return failure('APP_CONTROL_NOT_VISIBLE', '目标控件已隐藏、被遮挡或不可用。');
    const { x, y } = point;
    const start = startPoint(pointer.position, contents, x, y);
    const overlay = overlayFor?.(profileId);
    const physicalPoint = overlay && screenPoint(contents, name, x, y);
    try {
      const arrived = overlay
        ? await overlay.move(physicalPoint, pointer, signal, isCurrent)
        : await moveLocal(contents, start, point, isCurrent);
      if (!arrived) return failure('APP_SURFACE_CHANGED', '操作期间目标界面发生变化。');
      const current = await execute(contents, readControl, ref);
      const validScreenTarget = () => !overlay || (overlay.hit(physicalPoint)
        && sameScreenPoint(physicalPoint, () => screenPoint(contents, name, x, y)));
      if (!isCurrent() || !controlStayedAt(current, x, y) || !validScreenTarget()) {
        return failure('APP_CONTROL_MOVED', '目标控件发生变化，请重新观察。');
      }
      sendAppInput(contents, x, y, input);
      pointer.position = { x, y, surface: contents };
      return { success: true, actionExecuted: true, surface: name, ref };
    } finally {
      if (overlay) overlay.hide();
      else if (!contents.isDestroyed() && contents.mainFrame === frame) await execute(contents, hidePointer).catch(() => {});
    }
  }

  return { observe, click };
}

module.exports = { createBrowserAppPointer };

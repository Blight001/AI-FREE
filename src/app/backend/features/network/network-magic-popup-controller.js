'use strict';

const fs = require('fs');
const path = require('path');
const { BrowserWindow, screen } = require('electron');

const POPUP_SIZES = {
  compact: { width: 212, height: 80 },
  details: { width: 448, height: 188 },
  expanded: { width: 448, height: 340 },
};
const TASKBAR_HEIGHT = 36;
const ANCHOR_GAP = 8;

let currentPopup = null;
let lastAnchor = null;

function getNetworkMagicPopupWindow() {
  return currentPopup && !currentPopup.isDestroyed() ? currentPopup : null;
}

function resolvePopupHtmlPath() {
  const candidates = [
    path.join(__dirname, '../../../frontend/views/network-magic-popup.html'),
    path.join(process.cwd(), 'src', 'app', 'frontend', 'views', 'network-magic-popup.html'),
  ];
  return candidates.find((file) => {
    try { return fs.existsSync(file); } catch (_) { return false; }
  }) || candidates[0];
}

function readAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object') return null;
  const left = Number(anchor.left);
  const right = Number(anchor.right);
  const top = Number(anchor.top);
  if (![left, right, top].every(Number.isFinite)) return null;
  return { left, right, top, bottom: Number(anchor.bottom) };
}

function contentZoom(mainWindow) {
  const zoom = Number(mainWindow?.webContents?.getZoomFactor?.());
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

function getContentBounds(window) {
  return window.getContentBounds?.() ?? window.getBounds();
}

function isCursorOnLauncher(parent, anchor) {
  if (!anchor) return false;
  const cursor = screen.getCursorScreenPoint();
  const content = getContentBounds(parent);
  const zoom = contentZoom(parent);
  const x = (cursor.x - content.x) / zoom;
  const y = (cursor.y - content.y) / zoom;
  return x >= anchor.left && x < anchor.right && y >= anchor.top && y < anchor.bottom;
}

function resolvePopupSize(size, fallback = POPUP_SIZES.compact) {
  return typeof size === 'string' && Object.hasOwn(POPUP_SIZES, size) ? POPUP_SIZES[size] : fallback;
}

function resolvePopupBounds(mainWindow, ui, size, anchor) {
  const content = getContentBounds(mainWindow);
  const zoom = contentZoom(mainWindow);
  const resolved = readAnchor(anchor) || readAnchor(lastAnchor);
  let desiredX;
  let desiredY;
  if (resolved) {
    const buttonCenterX = content.x + ((resolved.left + resolved.right) / 2) * zoom;
    desiredX = buttonCenterX - size.width / 2;
    desiredY = content.y + resolved.top * zoom - size.height - ANCHOR_GAP;
  } else {
    const sideView = typeof ui.getSideView === 'function' ? ui.getSideView() : null;
    const sideVisible = sideView?.getVisible?.() !== false;
    const sideWidth = sideVisible ? (Number(sideView?.getBounds?.()?.width) || 0) : 0;
    const areaWidth = Math.max(size.width, Number(content.width) - sideWidth);
    desiredX = Number(content.x) + Math.max(8, (areaWidth - size.width) / 2);
    desiredY = Number(content.y) + Number(content.height) - TASKBAR_HEIGHT - size.height - ANCHOR_GAP;
  }
  const display = screen.getDisplayNearestPoint({ x: desiredX, y: desiredY });
  const work = display?.workArea || { x: 0, y: 0, width: 1920, height: 1080 };
  return {
    x: Math.round(Math.min(Math.max(desiredX, work.x + 8), work.x + work.width - size.width - 8)),
    y: Math.round(Math.min(Math.max(desiredY, work.y + 8), work.y + work.height - size.height - 8)),
    width: size.width,
    height: size.height,
  };
}

function notifyToggle(ui, open) {
  try { ui.sendToSide?.('network-magic-panel-toggle', { open: open === true }); } catch (_) {}
}

function createPopupWindow(mainWindow, bounds) {
  return new BrowserWindow({
    parent: mainWindow,
    ...bounds,
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#232327',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, '../../preload.js'),
    },
  });
}

function dismissOnPopupBlur(popup, hide) {
  if (currentPopup !== popup || !popup.isVisible()) return;
  const parent = popup.getParentWindow();
  const overLauncher = parent && isCursorOnLauncher(parent, lastAnchor);
  // The parent receives focus before the launcher receives its click.
  setImmediate(() => {
    if (currentPopup !== popup || popup.isFocused()) return;
    if (!(overLauncher && parent.isFocused())) hide();
  });
}

/** @param {{ui?: {getMainWindow?: () => import("electron").BrowserWindow | null, getSideView?: () => import("electron").WebContentsView | null, sendToSide?: (channel: string, payload: {open: boolean}) => unknown}}} [options] */
function createNetworkMagicPopupController({ ui } = {}) {
  let ready = false;
  let opening = false;

  const close = () => {
    const popup = currentPopup;
    currentPopup = null;
    lastAnchor = null;
    opening = false;
    if (popup && !popup.isDestroyed()) {
      try { popup.close(); } catch (_) {}
    }
    notifyToggle(ui, false);
  };

  const hide = () => {
    opening = false;
    const popup = getNetworkMagicPopupWindow();
    if (!popup?.isVisible()) return;
    // 停止、重启和保存模式由弹窗串联，失焦时保留正在执行的流程。
    popup.hide();
    notifyToggle(ui, false);
  };

  /** @param {{size?: string}} [options] */
  const resize = ({ size } = {}) => {
    const popup = getNetworkMagicPopupWindow();
    const parent = popup?.getParentWindow();
    if (!parent) return;
    popup.setBounds(resolvePopupBounds(parent, ui, resolvePopupSize(size, popup.getBounds()), lastAnchor));
  };

  const reveal = (popup) => {
    opening = false;
    popup.show();
    popup.focus();
    notifyToggle(ui, true);
  };

  /** @param {{anchor?: unknown}} [options] */
  const show = (options = {}) => {
    const mainWindow = typeof ui.getMainWindow === 'function' ? ui.getMainWindow() : null;
    if (!mainWindow || mainWindow.isDestroyed?.()) return false;
    const nextAnchor = readAnchor(options.anchor);
    if (nextAnchor) lastAnchor = nextAnchor;
    const existing = getNetworkMagicPopupWindow();
    const size = existing?.getBounds() ?? POPUP_SIZES.compact;
    const bounds = resolvePopupBounds(mainWindow, ui, size, lastAnchor);
    if (existing) {
      existing.setBounds(bounds);
      if (ready) reveal(existing);
      else opening = true;
      return true;
    }
    const popup = createPopupWindow(mainWindow, bounds);
    currentPopup = popup;
    ready = false;
    opening = true;
    try { popup.setAlwaysOnTop(true, 'pop-up-menu'); } catch (_) {}
    popup.on('blur', () => dismissOnPopupBlur(popup, hide));
    popup.on('closed', () => {
      if (currentPopup !== popup) return;
      currentPopup = null;
      lastAnchor = null;
      opening = false;
      notifyToggle(ui, false);
    });
    popup.loadFile(resolvePopupHtmlPath());
    popup.once('ready-to-show', () => {
      if (currentPopup !== popup || popup.isDestroyed()) return;
      ready = true;
      if (opening) reveal(popup);
    });
    return true;
  };

  /** @param {{anchor?: unknown}} [payload] */
  const toggle = (payload = {}) => {
    if (opening || getNetworkMagicPopupWindow()?.isVisible()) {
      hide();
      return false;
    }
    return show(payload);
  };

  return { toggle, resize, close, getWindow: getNetworkMagicPopupWindow };
}

module.exports = {
  createNetworkMagicPopupController,
  getNetworkMagicPopupWindow,
  resolvePopupBounds,
};

'use strict';

const fs = require('fs');
const path = require('path');
const { BrowserWindow, screen } = require('electron');

const COMPACT_SIZE = { width: 448, height: 248 };
const EXPANDED_SIZE = { width: 448, height: 560 };
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

function resolvePopupBounds(mainWindow, ui, expanded, anchor) {
  const size = expanded === true ? EXPANDED_SIZE : COMPACT_SIZE;
  const content = typeof mainWindow.getContentBounds === 'function'
    ? mainWindow.getContentBounds()
    : mainWindow.getBounds();
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

function createNetworkMagicPopupController({ ui } = {}) {
  const close = () => {
    const popup = currentPopup;
    currentPopup = null;
    lastAnchor = null;
    if (popup && !popup.isDestroyed()) {
      try { popup.close(); } catch (_) {}
    }
    notifyToggle(ui, false);
  };

  const show = ({ expanded = false, anchor } = {}) => {
    const mainWindow = typeof ui.getMainWindow === 'function' ? ui.getMainWindow() : null;
    if (!mainWindow || mainWindow.isDestroyed?.()) return false;
    const nextAnchor = readAnchor(anchor);
    if (nextAnchor) lastAnchor = nextAnchor;
    const bounds = resolvePopupBounds(mainWindow, ui, expanded === true, lastAnchor);
    if (currentPopup && !currentPopup.isDestroyed()) {
      currentPopup.setBounds(bounds);
      currentPopup.show();
      currentPopup.focus();
      notifyToggle(ui, true);
      return true;
    }
    const popup = new BrowserWindow({
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
      backgroundColor: '#151b25',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        preload: path.join(__dirname, '../../preload.js'),
      },
    });
    currentPopup = popup;
    try { popup.setAlwaysOnTop(true, 'pop-up-menu'); } catch (_) {}
    popup.on('closed', () => {
      if (currentPopup !== popup) return;
      currentPopup = null;
      notifyToggle(ui, false);
    });
    popup.loadFile(resolvePopupHtmlPath());
    popup.once('ready-to-show', () => {
      if (currentPopup !== popup || popup.isDestroyed()) return;
      try {
        popup.show();
        popup.focus();
        notifyToggle(ui, true);
      } catch (_) {}
    });
    return true;
  };

  const toggle = (payload = {}) => {
    if (payload?.open !== true) {
      close();
      return false;
    }
    return show({ expanded: payload?.expanded === true, anchor: payload?.anchor });
  };

  return { toggle, close, getWindow: getNetworkMagicPopupWindow };
}

module.exports = {
  createNetworkMagicPopupController,
  getNetworkMagicPopupWindow,
  resolvePopupBounds,
};

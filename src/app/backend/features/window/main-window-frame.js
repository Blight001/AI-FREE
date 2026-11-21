'use strict';

const titleBarHeight = process.platform === 'win32' ? 32 : 0;

function mainWindowFrameOptions() {
  if (!titleBarHeight) return { titleBarStyle: 'default' };
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { height: titleBarHeight, color: '#00000000', symbolColor: '#27272a' },
  };
}

function updateMainWindowFrameTheme(window, theme) {
  if (titleBarHeight) window.setTitleBarOverlay?.({ symbolColor: theme === 'light' ? '#27272a' : '#f4f4f5' });
}

function resolveMainWindowPageBounds(window, uiScale) {
  const [width, height] = window.getContentSize();
  const scale = Math.min(1.2, Math.max(1, Number(uiScale) || 1));
  return { y: titleBarHeight, width, height: Math.max(0, height - titleBarHeight - Math.round(41 * scale)) };
}

module.exports = { mainWindowFrameOptions, updateMainWindowFrameTheme, resolveMainWindowPageBounds };

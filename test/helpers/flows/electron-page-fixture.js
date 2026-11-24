'use strict';

const { pathToFileURL } = require('node:url');
const { bindDomain } = require('./domains');
const { pageProbes } = require('./page-probes');
const { exerciseAiDraft } = require('./electron-ai-draft');
const { checkAiLayout } = require('./electron-ai-layout');

function electronPageFixture(BrowserWindow, layout) {
  let window;
  let currentPage;
  function liveWindow() {
    if (!window || window.isDestroyed()) throw new Error('PAGE_WINDOW_CLOSED');
    return window;
  }
  function close() {
    if (window && !window.isDestroyed()) window.destroy();
    window = undefined;
    currentPage = undefined;
    return { closed: true };
  }
  const binding = bindDomain('electron-pages', {
    open: async () => {
      if (window && !window.isDestroyed()) throw new Error('PAGE_WINDOW_ALREADY_OPEN');
      window = new BrowserWindow({ show: false, width: 1000, height: 700,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
      currentPage = undefined;
      return { opened: true };
    },
    load: async ({ page }) => {
      if (!Object.hasOwn(layout.pages, page)) throw new Error('UNKNOWN_APPLICATION_PAGE');
      currentPage = undefined;
      await liveWindow().loadFile(layout.pages[page]);
      currentPage = page;
      return { loaded: true };
    },
    inspect: async ({ page }) => {
      const target = liveWindow();
      if (page !== currentPage || !Object.hasOwn(pageProbes, page)) throw new Error('PAGE_PROBE_MISMATCH');
      if (target.webContents.getURL() !== pathToFileURL(layout.pages[page]).href) throw new Error('UNEXPECTED_PAGE_URL');
      return target.webContents.executeJavaScript(`(${pageProbes[page].toString()})()`);
    },
    checkAiDraft: async () => {
      const target = liveWindow();
      if (currentPage !== 'ai' || target.webContents.getURL() !== pathToFileURL(layout.pages.ai).href) {
        throw new Error('PAGE_PROBE_MISMATCH');
      }
      try {
        await checkAiLayout(target);
        await exerciseAiDraft(target.webContents);
      } catch (error) {
        console.error('AI draft interaction failed:', error);
        throw error;
      }
      return { verified: true };
    },
    close: async () => close(),
    inspectWindow: async () => ({ open: !!window && !window.isDestroyed() }),
  });
  return { ...binding, close };
}

module.exports = { electronPageFixture };

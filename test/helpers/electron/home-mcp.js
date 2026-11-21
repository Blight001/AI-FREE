'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { ipcMain } = require('electron');
const { createIpcRegistry } = require('../../../src/app/backend/ipc/registry');
const { poll, rendererProbe } = require('../flows/electron-controls');

async function checkHomeMcp(win, layout) {
  const backend = path.join(layout.root, 'src/app/backend/features');
  const { registerMcpCatalogIpc } = require(path.join(backend, 'browser/register-mcp-catalog-ipc.js'));
  const { createAiChatService } = require(path.join(backend, 'ai-chat/ai-chat-service.js'));
  const { getWindowTools } = createAiChatService({ browserWindowUi: { getTabs: () => new Map() }, aiSandboxDir: process.cwd() });
  const inspect = rendererProbe(win.webContents);
  const ipc = createIpcRegistry(ipcMain);
  let reads = 0;
  registerMcpCatalogIpc(ipc, {
    isDevMode: true, getMainWindow: () => win,
    getWindowTools: () => { reads += 1; return getWindowTools(); },
  });
  try {
    await win.loadFile(layout.pages.shell, { query: { dev: '0' } });
    assert.equal(await inspect(() => document.getElementById('home-mcp-tab').hidden), true);
    await win.loadFile(layout.pages.ai);
    assert.deepEqual(await inspect(async () => ({
      denied: (await /** @type {any} */ (window).aiFree.diagnostics.getMcpCatalog()).error.code,
      noGear: !document.getElementById('ai-chat-browser-trigger'),
      noPrompt: !document.getElementById('ai-prompt-diagnostics-dialog'),
    })), { denied: 'DEV_MODE_REQUIRED', noGear: true, noPrompt: true });
    await win.loadFile(layout.pages.shell, { query: { dev: '1' } });
    assert.equal(reads, 0);
    assert.equal(await inspect(() => {
      const tab = document.getElementById('home-mcp-tab');
      if (!tab.getBoundingClientRect().width) return false;
      tab.click();
      return tab.getAttribute('aria-selected') === 'true' && document.getElementById('home-browsers').hidden;
    }), true);
    const ready = () => inspect(() => document.querySelectorAll('#home-mcp-tools button').length === 13);
    assert.equal(await poll(ready, Boolean), true);
    assert.deepEqual(await inspect(() => {
      const button = document.querySelector('#home-mcp-tools [data-tool="browser_observe"]');
      if (button instanceof HTMLButtonElement) button.click();
      const read = (id) => document.getElementById(`home-mcp-${id}`).textContent;
      const bounds = document.getElementById('home-mcp').getBoundingClientRect();
      return {
        name: read('tool-name'),
        schema: JSON.parse(read('tool-schema')).properties.roles.type,
        prompt: read('prompt').includes('保存'),
        method: JSON.parse(read('request')).method,
        result: JSON.parse(read('response')).result.structuredContent.success,
        fits: bounds.width > 0 && bounds.right <= document.getElementById('browser-empty-state').getBoundingClientRect().right,
      };
    }), { name: 'browser_observe', schema: 'array', prompt: true, method: 'tools/call', result: true, fits: true });
    await inspect(() => {
      document.getElementById('home-browsers-tab').click();
      document.getElementById('home-mcp-tab').click();
    });
    assert.ok(await poll(() => reads, (count) => count === 2));
  } finally {
    ipc.dispose();
  }
}

module.exports = { checkHomeMcp };

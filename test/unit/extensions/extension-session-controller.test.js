'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createExtensionSessionController } = require('../../../src/app/backend/features/extensions/extension-session-controller');

function createFixture(plugins) {
  const state = { plugins };
  return createExtensionSessionController({
    fs,
    getState: () => state,
    logger: { log() {}, warn() {} },
    normalizeAbsolutePath: (value) => path.resolve(String(value || '')),
    path,
    prepareCompatExtensionPath: () => {
      throw new Error('统一插件加载不得创建兼容副本');
    },
  });
}

test('unified extension loading keeps using the selected plugin directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-extension-session-'));
  try {
    const selectedPath = path.join(root, 'selected-plugin');
    fs.mkdirSync(selectedPath, { recursive: true });
    fs.writeFileSync(path.join(selectedPath, 'manifest.json'), JSON.stringify({ manifest_version: 3 }));
    const controller = createFixture([{ id: 'selected', path: selectedPath, enabled: true }]);
    assert.deepEqual(controller.getEnabledExtensionPaths(), [path.resolve(selectedPath)]);

    const loadedPaths = [];
    const session = {
      extensions: {
        getAllExtensions: () => [],
        async loadExtension(extensionPath) {
          loadedPaths.push(extensionPath);
          return { id: 'loaded-selected', path: extensionPath };
        },
      },
    };
    await controller.loadPluginIntoSession({ id: 'selected', path: selectedPath, enabled: true }, session);
    assert.deepEqual(loadedPaths, [path.resolve(selectedPath)]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildRoot, withPackagedSource } = require('../../../scripts/build-source');

test('MCP 基准页面、脚本和样式随统一源码构建复制', async () => {
  const source = path.resolve(__dirname, '../../../src/app/frontend/views/mcp-benchmark-fixture');
  for (const name of ['index.html', 'benchmark.js', 'benchmark.css']) assert.equal(fs.existsSync(path.join(source, name)), true);
  const panel = path.resolve(__dirname, '../../../src/app/frontend/views/mcp-debug-panel.html');
  assert.equal(fs.readFileSync(panel, 'utf8').includes('../renderer/controllers/pages/mcp-debug-benchmark.js'), true);
  assert.equal(fs.existsSync(path.resolve(path.dirname(panel), '../renderer/controllers/pages/mcp-debug-benchmark.js')), true);
  await withPackagedSource((root) => {
    const target = path.join(root, 'src/app/frontend/views/mcp-benchmark-fixture');
    for (const name of ['index.html', 'benchmark.js', 'benchmark.css']) assert.equal(fs.existsSync(path.join(target, name)), true);
    const route = require(path.join(root, 'src/app/backend/config/paths.js')).resolveMcpBenchmarkFixturePath('index.html');
    assert.equal(route, path.join(root, 'src/app/frontend/views/mcp-benchmark-fixture/index.html'));
    const packagedPanel = path.join(root, 'src/app/frontend/views/mcp-debug-panel.html');
    assert.equal(fs.existsSync(packagedPanel), true);
    assert.equal(fs.existsSync(path.join(root, 'src/app/frontend/renderer/controllers/pages/mcp-debug-benchmark.js')), true);
  });
});

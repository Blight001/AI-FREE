'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createEditorStore } = require('../../../src/app/main/features/opencut/opencut-editor');
const { createOpenCutHost } = require('../../../src/app/main/features/opencut/opencut-host');
const { createOpenCutTools } = require('../../../src/app/main/features/opencut/opencut-tools');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

test('OpenCut host serves the local UI and status API', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencut-host-data-'));
  const webRoot = path.resolve(__dirname, '../../../resources/opencut/web');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const editor = createEditorStore(dataDir);
  let tools = null;
  const host = createOpenCutHost({
    host: '127.0.0.1',
    port: 0,
    webRoot,
    editor,
    logger: { log() {}, warn() {} },
    getTools: () => tools,
  });
  tools = createOpenCutTools({ editor, host, workspaceDir: dataDir });
  const started = await host.start();
  t.after(() => host.stop());
  assert.equal(started.running, true);
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

  const status = await getJson(`${started.url}api/status`);
  assert.equal(status.ok, true);
  assert.equal(status.running, true);
  const catalog = await getJson(`${started.url}api/tools`);
  assert.ok(catalog.tools.some((tool) => tool.name === 'opencut.status'));

  const page = await new Promise((resolve, reject) => {
    http.get(started.url, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    }).on('error', reject);
  });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /OpenCut/);
});

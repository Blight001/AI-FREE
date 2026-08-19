'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createOpenCutService } = require('../../../src/app/main/features/opencut/opencut-service');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try { resolve({ statusCode: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const parsed = new URL(url);
    const request = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('OpenCut service starts the local port and exposes the full tool catalog', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencut-service-data-'));
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencut-service-workspace-'));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });
  const service = createOpenCutService({
    dataDir,
    workspaceDir,
    webRoot: path.resolve(__dirname, '../../../resources/opencut/web'),
    port: 0,
    logger: { log() {}, warn() {} },
  });
  const started = await service.start();
  t.after(() => service.stop());
  assert.equal(started.running, true);
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

  const tools = service.createTools();
  const names = tools.tools.map((tool) => tool.name);
  assert.ok(names.includes('opencut.status'));
  assert.ok(names.includes('opencut.export'));
  assert.equal(names.length, 10);

  const created = await tools.execute('opencut.project.create', { name: '集成测试' });
  assert.equal(created.success, true);
  const clip = path.join(workspaceDir, 'clip.mp4');
  fs.writeFileSync(clip, 'video');
  const imported = await tools.execute('opencut.media.import', { path: 'clip.mp4' });
  assert.equal(imported.kind, 'video');

  const status = await getJson(`${started.url}api/status`);
  assert.equal(status.body.ok, true);
  assert.equal(status.body.running, true);
  assert.equal(status.body.active.name, '集成测试');

  const viaHttp = await postJson(`${started.url}api/timeline/edit`, {
    action: 'add', media_id: imported.id, duration_ms: 1200,
  });
  assert.equal(viaHttp.ok, true);
  assert.equal(viaHttp.result.duration_ms, 1200);
});

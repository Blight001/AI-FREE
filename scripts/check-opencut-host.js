'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createOpenCutService } = require('../src/app/main/features/opencut/opencut-service');

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

function getText(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    }).on('error', reject);
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencut-live-'));
  const service = createOpenCutService({
    dataDir,
    webRoot: path.resolve(__dirname, '../resources/opencut/web'),
    port: Number(process.env.AI_FREE_OPENCUT_PORT || 5173),
    logger: console,
  });
  try {
    const started = await service.start();
    if (!started.running) throw new Error(started.error || 'OpenCut 端口未启动');
    const status = await getJson(`${started.url}api/status`);
    const catalog = await getJson(`${started.url}api/tools`);
    const page = await getText(started.url);
    const names = (catalog.tools || []).map((tool) => tool.name);
    if (page.statusCode !== 200 || !page.body.includes('OpenCut')) {
      throw new Error('OpenCut 页面未就绪');
    }
    if (!names.includes('opencut.status') || names.length !== 10) {
      throw new Error(`工具目录不完整: ${names.join(',')}`);
    }
    console.log(JSON.stringify({
      ok: true,
      url: started.url,
      running: status.running,
      tools: names,
    }, null, 2));
  } finally {
    service.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

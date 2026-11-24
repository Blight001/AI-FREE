'use strict';

const { randomBytes, randomInt } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const { resolveMcpBenchmarkFixturePath } = require('../../config/paths');

const FIXTURE_FILE = Buffer.from('AI-FREE MCP BENCHMARK FILE v1\n');
const EXPECTED_ORDER = ['4', '1', '2', '3'];

function readAssets() {
  return new Map([['/', ['index.html', 'text/html']], ['/benchmark.js', ['benchmark.js', 'text/javascript']],
    ['/benchmark.css', ['benchmark.css', 'text/css']]].map(([route, [file, contentType]]) => [route,
    { body: fs.readFileSync(resolveMcpBenchmarkFixturePath(file)), contentType }]));
}

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

function bodyBytes(request, maxBytes = 512 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { reject(Object.assign(new Error('请求超过测试限制'), { statusCode: 413 })); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function extractUpload(request, body) {
  const boundary = /multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(request.headers['content-type'] || '');
  if (!boundary) return null;
  const marker = Buffer.from(`--${boundary[1] || boundary[2]}`);
  const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'));
  if (headerEnd < 0 || !body.subarray(0, headerEnd).includes(marker)) return null;
  const end = body.lastIndexOf(Buffer.concat([Buffer.from('\r\n'), marker]));
  return end > headerEnd ? body.subarray(headerEnd + 4, end) : null;
}

function recordEvent(state, input) {
  if (input.event === 'controls' && input.value === 'MCP-OK' && input.checked === true) {
    state.control = { value: input.value, checked: true };
  }
  if (input.event === 'sort' && Array.isArray(input.order)) state.order = input.order.map(String);
}

function createHandlers(state) {
  return new Map([
    ['POST /event', async (request, response) => {
      const body = await bodyBytes(request, 2048);
      recordEvent(state, JSON.parse(body.toString('utf8')));
      sendJson(response, 200, { ok: true });
    }],
    ['GET /download', (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="mcp-benchmark.txt"', 'Content-Length': FIXTURE_FILE.length });
      response.end(FIXTURE_FILE);
    }],
    ['POST /upload', async (request, response) => {
      const file = extractUpload(request, await bodyBytes(request));
      state.uploaded = Boolean(file && file.equals(FIXTURE_FILE));
      response.writeHead(state.uploaded ? 200 : 422, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(state.uploaded ? '上传文件校验通过' : '上传文件不符合基准要求');
    }],
  ]);
}

function serveAsset(response, route, assets, prefix, expectedCpu) {
  const asset = assets.get(route);
  if (!asset) return false;
  const body = route === '/' ? String(asset.body).replaceAll('{{route}}', prefix).replaceAll('{{cpu}}', expectedCpu) : asset.body;
  response.writeHead(200, { 'Content-Type': `${asset.contentType}; charset=utf-8`, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
  response.end(body);
  return true;
}

async function openMcpBenchmarkFixture() {
  const assets = readAssets();
  const token = randomBytes(18).toString('hex');
  const prefix = `/mcp-benchmark/${token}`;
  const expectedCpu = `${(randomInt(0, 10000) / 100).toFixed(2)}%`;
  const state = { control: null, order: null, uploaded: false };
  let server;
  const routes = createHandlers(state);
  server = http.createServer(async (request, response) => {
    const address = server.address();
    const localHost = address && typeof address !== 'string' && request.headers.host === `127.0.0.1:${address.port}`;
    if (!localHost || !request.url?.startsWith(prefix)) { response.writeHead(404).end(); return; }
    const route = request.url.slice(prefix.length) || '/';
    try {
      if (serveAsset(response, route, assets, prefix, expectedCpu)) return;
      const handler = routes.get(`${request.method} ${route}`);
      if (handler) { await handler(request, response); return; }
      response.writeHead(404).end();
    } catch (error) {
      if (!response.headersSent) response.writeHead(error.statusCode || 400);
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法启动本机 MCP 基准服务');
  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}${prefix}/`, expectedCpu,
    snapshot: () => ({ control: state.control && { ...state.control }, order: state.order && [...state.order],
      uploaded: state.uploaded }),
    close() { if (closed) return; closed = true; server.close(); server.closeAllConnections(); },
  };
}

module.exports = { EXPECTED_ORDER, FIXTURE_FILE, openMcpBenchmarkFixture };


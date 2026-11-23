'use strict';

const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const { DEBUG_FIXTURE_PATH } = require('../../../shared/mcp-mouse-debug');
const { resolveMcpDebugFixturePath } = require('../../config/paths');

function fixtureAssets() {
  const files = [['index.html', 'text/html'], ['frame.html', 'text/html'], ['fixture.js', 'text/javascript'], ['fixture.css', 'text/css']];
  return new Map(files.map(([file, contentType]) => [file, {
    contentType, body: fs.readFileSync(resolveMcpDebugFixturePath(file)),
  }]));
}

async function openMcpDebugFixture() {
  const assets = fixtureAssets();
  const name = randomBytes(16).toString('hex');
  const route = DEBUG_FIXTURE_PATH + name;
  const serve = (request, response) => {
    const address = server.address();
    const isLocal = request.headers.host === `127.0.0.1:${typeof address === 'object' && address?.port}`;
    const file = request.url === route ? 'index.html' : request.url?.startsWith(`${route}/`)
      ? request.url.slice(route.length + 1) : '';
    const asset = isLocal && request.method === 'GET' && assets.get(file);
    if (!asset) { response.writeHead(404).end(); return; }
    const body = file === 'index.html' ? String(asset.body).replaceAll('{{route}}', route) : asset.body;
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'; frame-ancestors 'self'; form-action 'none'; base-uri 'none'");
    response.setHeader('Content-Type', `${asset.contentType}; charset=utf-8`);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.end(body);
  };
  const server = http.createServer(serve);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法获取本地测试页端口');
  return {
    url: `http://127.0.0.1:${address.port}${route}`,
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}

module.exports = { openMcpDebugFixture };

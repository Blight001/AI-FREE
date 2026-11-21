'use strict';

const { createHash } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { ASSETS, FILENAME, assetPath, sourcePage, uploadPage } = require('./pages');
const { MODEL_PATH, MODEL_ID, API_KEY, modelResponse } = require('./local-model');

const HOST = '127.0.0.1';
const MAX_FILE_BYTES = 1024 * 1024;

function emptyTarget() {
  return { selectionCount: 0, receivedCount: 0, lastSelected: null, lastReceived: null, droppedReceipts: 0 };
}

function reply(response, status, type, body) {
  response.writeHead(status, { 'Content-Type': type });
  response.end(body);
}

function json(response, status, data) {
  reply(response, status, 'application/json; charset=utf-8', JSON.stringify(data));
}

function rejectFile(status) {
  const error = new Error('Invalid fixture upload');
  error.status = status;
  throw error;
}

function fileName(request) {
  let name;
  try { name = decodeURIComponent(request.headers['x-fixture-filename'] ?? ''); }
  catch { return rejectFile(400); }
  if (!name || name.length > 160 || /[/\\\x00-\x1f\x7f]/.test(name)) rejectFile(400);
  return name;
}

async function summarizeFile(request) {
  const name = fileName(request);
  if (Number(request.headers['content-length']) > MAX_FILE_BYTES) rejectFile(413);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_FILE_BYTES) rejectFile(413);
    hash.update(chunk);
  }
  return { name, size, sha256: hash.digest('hex') };
}

async function recordFile(request, response, target, action, dropReceipt) {
  const summary = await summarizeFile(request);
  if (action === 'select') {
    target.selectionCount++;
    target.lastSelected = summary;
  } else {
    target.receivedCount++;
    target.lastReceived = summary;
    if (dropReceipt && !target.droppedReceipts) {
      // Start a receipt so Chromium will not transparently replay the POST on an empty response.
      target.droppedReceipts++;
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8', 'Content-Length': 16, Connection: 'close',
      });
      response.end('{');
      return;
    }
  }
  json(response, 200, target);
}

function caseMode(url, target) {
  const mode = url.searchParams.get('mode') ?? 'normal';
  return mode === 'normal' || (target === 'b' && mode === 'drop-once') ? mode : null;
}

function createRouter(uploadScript) {
  const reset = () => ({ b: emptyTarget(), c: emptyTarget() });
  let state = reset();
  const assets = new Map(Object.values(ASSETS).map((asset) => [assetPath(asset), asset.bytes]));

  function readRoute(response, url) {
    const route = url.pathname;
    if (route === '/state') return json(response, 200, state);
    if (route === '/a') return reply(response, 200, 'text/html; charset=utf-8', sourcePage());
    if (route === '/upload-page.js') return reply(response, 200, 'text/javascript; charset=utf-8', uploadScript);
    if (assets.has(route)) return reply(response, 200, 'image/png', assets.get(route));
    const target = /^\/(b|c)$/.exec(route)?.[1];
    const mode = target && caseMode(url, target);
    if (mode) return reply(response, 200, 'text/html; charset=utf-8', uploadPage(target, mode));
    return json(response, 404, { error: 'fixture route not found' });
  }

  return async (request, response, origin) => {
    const url = new URL(request.url, origin);
    if (url.pathname === MODEL_PATH) {
      const { status, data } = await modelResponse(request, origin);
      return json(response, status, data);
    }
    if (request.method === 'GET') return readRoute(response, url);
    if (request.method !== 'POST') return json(response, 405, { error: 'method not allowed' });
    if (request.headers.origin !== origin) return json(response, 403, { error: 'fixture origin required' });
    if (url.pathname === '/reset') {
      state = reset();
      return json(response, 200, state);
    }
    const match = /^\/(b|c)\/(select|submit)$/.exec(url.pathname);
    const mode = match && caseMode(url, match[1]);
    if (!mode) return json(response, 404, { error: 'fixture route not found' });
    return recordFile(request, response, state[match[1]], match[2], mode === 'drop-once');
  };
}

function createServer(uploadScript) {
  const route = createRouter(uploadScript);
  const server = http.createServer({ requestTimeout: 5000, headersTimeout: 5000 }, (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'");
    const authority = `${HOST}:${server.address()?.port}`;
    if (request.headers.host !== authority) return json(response, 403, { error: 'fixture host required' });
    void route(request, response, `http://${authority}`).catch((error) => {
      if (response.destroyed || response.headersSent) return;
      response.setHeader('Connection', 'close');
      json(response, error.status || 400, { error: 'invalid fixture request' });
    });
  });
  server.setTimeout(5000, (socket) => socket.destroy());
  return server;
}

async function seedWorkspace(root) {
  const userData = path.join(root, 'user-data');
  const desktop = path.join(root, 'desktop');
  const workspace = path.join(desktop, 'AI-Workspace');
  await fs.mkdir(userData);
  const files = {};
  for (const [key, asset] of Object.entries(ASSETS)) {
    const directory = path.join(workspace, asset.id);
    const file = path.join(directory, FILENAME);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(file, asset.bytes);
    files[key] = { path: file, route: assetPath(asset), sha256: createHash('sha256').update(asset.bytes).digest('hex') };
  }
  const commandDirectory = path.join(workspace, 'command');
  const command = path.join(commandDirectory, 'delayed-command.js');
  await fs.mkdir(commandDirectory);
  await fs.copyFile(path.join(__dirname, 'delayed-command.js'), command);
  return { root, userData, desktop, workspace, files, command, commandMarker: path.join(commandDirectory, 'completed.marker') };
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  return closed;
}

async function startFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-free-interaction-'));
  let server;
  // Only remove the exact directory just allocated by this fixture.
  const removeRoot = () => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  try {
    const paths = await seedWorkspace(root);
    server = createServer(await fs.readFile(path.join(__dirname, 'upload-page.js')));
    const listening = once(server, 'listening');
    server.listen(0, HOST);
    await listening;
    const origin = `http://${HOST}:${server.address().port}`;
    let closing;
    const close = () => closing ??= closeServer(server).finally(removeRoot);
    return { origin, urls: { a: `${origin}/a`, b: `${origin}/b`, c: `${origin}/c`,
      dropOnce: `${origin}/b?mode=drop-once`, state: `${origin}/state`, reset: `${origin}/reset`, model: origin + MODEL_PATH },
    model: { id: MODEL_ID, apiKey: API_KEY }, ...paths, close };
  } catch (error) {
    await closeServer(server).finally(removeRoot);
    throw error;
  }
}

async function main() {
  const signal = new AbortController();
  const stop = () => signal.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let fixture;
  try {
    fixture = await startFixture();
    console.log(JSON.stringify(fixture));
    if (!signal.signal.aborted) await once(signal.signal, 'abort');
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await fixture?.close();
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { startFixture };

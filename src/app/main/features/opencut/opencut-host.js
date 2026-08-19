'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { DEFAULT_OPENCUT_HOST, DEFAULT_OPENCUT_PORT } = require('./opencut-constants');
const { available: ffmpegAvailable } = require('./opencut-ffmpeg');

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function safeStaticPath(webRoot, urlPath) {
  const relative = decodeURIComponent(String(urlPath || '/').split('?')[0]);
  const cleaned = relative === '/' ? 'index.html' : relative.replace(/^[/\\]+/, '');
  const target = path.resolve(webRoot, cleaned);
  const root = path.resolve(webRoot);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return '';
  return target;
}

function sendFile(res, filePath) {
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const body = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
  res.end(body);
}

function publicStatus(state) {
  const running = Boolean(state.server && state.server.listening);
  return {
    running,
    host: state.host,
    port: running ? state.boundPort : state.requestedPort,
    url: running ? `http://${state.host}:${state.boundPort}/` : '',
    web_root: state.webRoot,
    web_exists: fs.existsSync(path.join(state.webRoot, 'index.html')),
    last_error: state.lastError,
  };
}

function listToolDefs(options) {
  return (typeof options.getTools === 'function' ? options.getTools() : options.tools)?.tools || [];
}

async function handleApi(state, req, res, url) {
  const method = String(req.method || 'GET').toUpperCase();
  const route = `${method} ${url.pathname}`;
  const gets = {
    'GET /api/status': () => ({ ok: true, ffmpeg: ffmpegAvailable(), ...publicStatus(state), ...state.editor.snapshot() }),
    'GET /api/projects': () => ({ ok: true, projects: state.editor.listProjects() }),
    'GET /api/timeline': () => ({ ok: true, ...state.editor.timeline(url.searchParams.get('project_id')) }),
    'GET /api/tools': () => ({ ok: true, tools: listToolDefs(state.options) }),
  };
  if (gets[route]) {
    sendJson(res, 200, gets[route]());
    return;
  }
  if (method !== 'POST') {
    sendJson(res, 404, { ok: false, error: '接口不存在' });
    return;
  }
  const args = await readJson(req);
  const actions = {
    '/api/projects': () => state.editor.createProject(args.name, args),
    '/api/projects/open': () => state.editor.openProject(args.project_id),
    '/api/media/import': () => state.editor.importMedia(args.path, { ...args, workspaceDir: state.workspaceDir }),
    '/api/timeline/edit': () => state.editor.edit(args),
  };
  const action = actions[url.pathname];
  if (!action) {
    sendJson(res, 404, { ok: false, error: '接口不存在' });
    return;
  }
  sendJson(res, 200, { ok: true, result: action() });
}

async function handleRequest(state, req, res) {
  const url = new URL(req.url || '/', `http://${state.host}:${state.boundPort}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(state, req, res, url);
      return;
    }
    const filePath = safeStaticPath(state.webRoot, url.pathname);
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      sendJson(res, 404, { ok: false, error: '页面不存在' });
      return;
    }
    sendFile(res, filePath);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error?.message || String(error) });
  }
}

function listen(state) {
  return new Promise((resolve, reject) => {
    const next = http.createServer((req, res) => { void handleRequest(state, req, res); });
    next.once('error', reject);
    next.listen(state.requestedPort, state.host, () => {
      next.off('error', reject);
      const address = next.address();
      state.boundPort = typeof address === 'object' && address ? address.port : state.requestedPort;
      state.server = next;
      state.lastError = '';
      resolve(publicStatus(state));
    });
  });
}

async function startHost(state) {
  if (state.server?.listening) {
    const info = publicStatus(state);
    info.summary = `OpenCut 已在运行: ${info.url}`;
    return info;
  }
  if (!fs.existsSync(path.join(state.webRoot, 'index.html'))) {
    state.lastError = `未找到 OpenCut 界面: ${state.webRoot}`;
    throw new Error(state.lastError);
  }
  try {
    const info = await listen(state);
    info.summary = `已启动 OpenCut Web ${info.url}`;
    state.logger.log?.(`[OpenCut] ${info.summary}`);
    return info;
  } catch (error) {
    state.lastError = error?.message || String(error);
    state.logger.warn?.('[OpenCut] 启动失败:', state.lastError);
    throw error;
  }
}

function stopHost(state) {
  const current = state.server;
  state.server = null;
  if (current) current.close();
  state.lastError = '';
  return publicStatus(state);
}

function createOpenCutHost(options = {}) {
  const state = {
    options,
    host: String(options.host || DEFAULT_OPENCUT_HOST),
    requestedPort: Number(options.port || DEFAULT_OPENCUT_PORT),
    webRoot: path.resolve(String(options.webRoot || '')),
    editor: options.editor,
    workspaceDir: options.workspaceDir || '',
    logger: options.logger || console,
    server: null,
    boundPort: Number(options.port || DEFAULT_OPENCUT_PORT),
    lastError: '',
  };
  return {
    start: () => startHost(state),
    stop: () => stopHost(state),
    status: () => publicStatus(state),
    handle: (req, res) => handleRequest(state, req, res),
  };
}

module.exports = { createOpenCutHost };

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createBrowserAutomationExternalGateway,
} = require('../../../src/app/backend/services/browser-automation-external-gateway');

function createFixture(root, overrides = {}) {
  const calls = [];
  const softwareTools = {
    tools: [{
      name: 'software_window',
      description: '管理软件窗口',
      input_schema: { type: 'object', properties: { action: { type: 'string' }, name: { type: 'string' } } },
      destructive: true,
    }],
    has: (name) => name === 'software_window',
    execute: overrides.executeSoftware || (async (name, args) => ({ success: true, name, args })),
  };
  const connections = overrides.connections || [{
    id: 'connection-1',
    name: 'Primary',
    browserName: '工作窗口',
    online: true,
    capabilities: ['browser_observe', 'save_cookies'],
  }];
  const toolDefs = overrides.toolDefs || [
    { name: 'browser_observe', description: '观察页面', input_schema: { type: 'object', properties: { keyword: { type: 'string' } } } },
    { name: 'save_cookies', description: '保存 Cookie', input_schema: { type: 'object', properties: { save_to_server: { type: 'boolean' }, server_url: { type: 'string' } } } },
  ];
  const gateway = createBrowserAutomationExternalGateway({
    descriptorPath: path.join(root, 'ai-free-mcp-bridge.json'),
    dispatch: async (connectionId, name, args, options) => {
      calls.push({ connectionId, name, args, options });
      return { success: true, connectionId, name, args };
    },
    getConnection: (id) => connections.some((item) => item.id === id) ? { ...connections.find((item) => item.id === id), tools: toolDefs } : null,
    listConnections: () => connections,
    getActiveConnectionId: overrides.getActiveConnectionId,
    getAccess: overrides.getAccess || (() => true),
    overviewTool: overrides.overviewTool,
    getBrowserOverview: overrides.getBrowserOverview,
    logger: { log() {}, warn() {} },
  });
  gateway.configure({ getConnections: () => connections, getWindowTools: () => softwareTools });
  return { calls, connections, gateway };
}

test('browser overview is globally callable without a selected or open browser window', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-external-mcp-overview-'));
  try {
    const overview = { success: true, action: 'overview', browser_records: [], open_browsers: [] };
    const { gateway } = createFixture(root, {
      connections: [],
      overviewTool: {
        name: 'browser_control', description: '读取完整状态',
        input_schema: { type: 'object', properties: { action: { type: 'string' } } },
      },
      getBrowserOverview: async () => overview,
    });

    assert.equal(gateway.listTools().tools.some((tool) => tool.name === 'browser_control'), true);
    assert.deepEqual(await gateway.callTool('browser_control', { action: 'overview' }), overview);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('external gateway without a descriptor path does not create a cwd temp file', () => {
  const gateway = createBrowserAutomationExternalGateway({ getAccess: () => true });

  assert.equal(gateway.publish({ host: '127.0.0.1', port: 18765 }), false);
  assert.equal(gateway.descriptorPath, '');
});

test('external gateway removes its atomic temp file when descriptor commit fails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-external-mcp-failed-publish-'));
  const occupiedPath = path.join(root, 'occupied-descriptor');
  fs.mkdirSync(occupiedPath);
  const gateway = createBrowserAutomationExternalGateway({
    descriptorPath: occupiedPath,
    getAccess: () => true,
  });
  try {
    assert.throws(() => gateway.publish({ host: '127.0.0.1', port: 18765 }));
    assert.deepEqual(
      fs.readdirSync(root).filter((name) => name.endsWith('.tmp')),
      [],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('external gateway combines software and per-window MCP tools with routing fields', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-external-mcp-tools-'));
  try {
    const { calls, gateway } = createFixture(root);
    const listed = gateway.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ['software_window', 'browser_observe', 'save_cookies']);
    assert.equal(listed.connections[0].name, '工作窗口');
    const observe = listed.tools.find((tool) => tool.name === 'browser_observe');
    assert.equal(observe.inputSchema.properties.change_browser.type, 'string');
    assert.equal(observe.inputSchema.properties.keyword.type, 'string');
    const cookie = listed.tools.find((tool) => tool.name === 'save_cookies');
    assert.equal(cookie.inputSchema.properties.save_to_server, undefined);
    assert.equal(cookie.inputSchema.properties.server_url, undefined);

    const software = await gateway.callTool('software_window', { action: 'create', name: 'Research' });
    assert.equal(software.args.name, 'Research');
    const browser = await gateway.callTool('browser_observe', { change_browser: 'connection-1', keyword: '提交' });
    assert.equal(browser.connectionId, 'connection-1');
    assert.deepEqual(calls[0].args, { keyword: '提交' });
    assert.equal(calls[0].options.timeoutMs, 180000);
    await assert.rejects(
      gateway.callTool('save_cookies', { change_browser: 'connection-1', save_to_server: true }),
      /不允许回传或上传 Cookie/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('external gateway requires an explicit browser route when multiple windows are connected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-external-mcp-route-'));
  try {
    const { gateway } = createFixture(root, { connections: [
      { id: 'one', browserName: '窗口一', online: true },
      { id: 'two', browserName: '窗口二', online: true },
    ] });
    const listed = gateway.listTools();
    assert.equal(listed.controlled_browser_id, 'one');
    const result = await gateway.callTool('browser_observe', { change_browser: '窗口二' });
    assert.equal(result.connectionId, 'two');
    const continued = await gateway.callTool('browser_observe', {});
    assert.equal(continued.connectionId, 'two');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('external gateway follows independent browser tab switches without discarding an explicit route', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-external-mcp-active-browser-'));
  let activeConnectionId = 'one';
  try {
    const { gateway } = createFixture(root, {
      connections: [
        { id: 'one', browserName: '窗口一', online: true },
        { id: 'two', browserName: '窗口二', online: true },
      ],
      getActiveConnectionId: () => activeConnectionId,
      toolDefs: [{
        name: 'browser_tab', description: '读取标签页',
        input_schema: { type: 'object', properties: { action: { type: 'string' } } },
      }],
    });
    assert.equal(gateway.listTools().controlled_browser_id, 'one');

    activeConnectionId = 'two';
    const switched = await gateway.callTool('browser_tab', { action: 'list' });
    assert.equal(switched.connectionId, 'two');

    const explicit = await gateway.callTool('browser_tab', { change_browser: 'one', action: 'list' });
    assert.equal(explicit.connectionId, 'one');
    const continued = await gateway.callTool('browser_tab', { action: 'list' });
    assert.equal(continued.connectionId, 'one');

    activeConnectionId = 'one';
    assert.equal((await gateway.callTool('browser_tab', { action: 'list' })).connectionId, 'one');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('external gateway publishes a protected descriptor and authenticates HTTP calls', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-external-mcp-http-'));
  const { gateway } = createFixture(root);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${server.address()?.port || 0}`);
    void gateway.handle(req, res, url).then((handled) => {
      if (!handled) { res.statusCode = 404; res.end(); }
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    gateway.publish({ host: '127.0.0.1', port });
    const descriptorPath = path.join(root, 'ai-free-mcp-bridge.json');
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
    assert.equal(descriptor.endpoint, `http://127.0.0.1:${port}`);
    assert.equal(descriptor.entitlement, 'vip');
    assert.equal(descriptor.token.length, 64);

    const unauthorized = await fetch(`${descriptor.endpoint}/mcp/v1/status`);
    assert.equal(unauthorized.status, 401);
    const authorized = await fetch(`${descriptor.endpoint}/mcp/v1/tools`, {
      headers: { 'x-ai-free-mcp-token': descriptor.token },
    });
    assert.equal(authorized.status, 200);
    const payload = await authorized.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.tools.some((tool) => tool.name === 'software_window'), true);

    const failed = await fetch(`${descriptor.endpoint}/mcp/v1/call`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ai-free-mcp-token': descriptor.token,
      },
      body: JSON.stringify({ name: 'missing_tool', arguments: {} }),
    });
    assert.equal(failed.status, 400);
    assert.deepEqual(await failed.json(), {
      ok: false,
      error: 'AI_FREE_MCP_CALL_FAILED',
      message: '窗口「工作窗口」不支持 MCP 工具: missing_tool',
      phase: 'external_gateway',
      retryable: false,
    });

    gateway.unpublish();
    assert.equal(fs.existsSync(descriptorPath), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('external gateway serves the Streamable HTTP MCP JSON-RPC contract', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-external-mcp-json-rpc-'));
  const { gateway } = createFixture(root);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${server.address()?.port || 0}`);
    void gateway.handle(req, res, url).then((handled) => {
      if (!handled) { res.statusCode = 404; res.end(); }
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    gateway.publish({ host: '127.0.0.1', port });
    const connection = gateway.getConnectionInfo();
    assert.deepEqual(connection, {
      endpoint: `http://127.0.0.1:${port}/mcp/v1`,
      token: JSON.parse(fs.readFileSync(path.join(root, 'ai-free-mcp-bridge.json'), 'utf8')).token,
    });
    const headers = { 'content-type': 'application/json', 'x-ai-free-mcp-token': connection.token };
    const initialize = await fetch(connection.endpoint, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(initialize.status, 200);
    assert.equal((await initialize.json()).result.protocolVersion, '2025-06-18');

    const tools = await fetch(connection.endpoint, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    assert.equal(tools.status, 200);
    assert.equal((await tools.json()).result.tools.some((tool) => tool.name === 'software_window'), true);

    const call = await fetch(connection.endpoint, {
      method: 'POST', headers,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'software_window', arguments: { action: 'list' } },
      }),
    });
    assert.equal(call.status, 200);
    const called = await call.json();
    assert.equal(called.result.isError, false);
    assert.equal(JSON.parse(called.result.content[0].text).success, true);

    gateway.options.dispatch = async () => ({ success: true, dataUrl: 'data:image/png;base64,aGVsbG8=', observationId: 'obs-test' });
    const imageCall = await fetch(connection.endpoint, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'browser_observe', arguments: {} } }),
    });
    const imageResult = (await imageCall.json()).result;
    assert.equal(imageResult.content[1].type, 'image');
    assert.equal(imageResult.content[1].mimeType, 'image/png');
    assert.equal(imageResult.structuredContent.dataUrl, undefined);
    assert.equal(imageResult.content[0].text.includes('aGVsbG8='), false);
    gateway.options.dispatch = async () => ({ success: false, errorCode: 'OBSERVED_REF_EXPIRED' });
    const failedCall = await fetch(connection.endpoint, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'browser_observe', arguments: {} } }),
    });
    assert.equal((await failedCall.json()).result.isError, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('closing an MCP HTTP request cancels the running software tool', { timeout: 3000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-external-abort-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let start;
  const started = new Promise((resolve) => { start = resolve; });
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const { gateway } = createFixture(root, { executeSoftware: async (_name, _args, options) => {
    start(options?.signal);
    if (!options?.signal) return { success: false };
    return new Promise((resolve) => options.signal.addEventListener('abort', () => {
      finish(true);
      resolve({ success: false });
    }, { once: true }));
  } });
  const server = http.createServer((req, res) => gateway.handle(req, res, new URL(req.url, 'http://127.0.0.1')));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const request = http.request({ host: '127.0.0.1', port: address.port, method: 'POST', path: '/mcp/v1',
    headers: { Authorization: 'Bearer ' + gateway.token } });
  request.on('error', () => {});
  t.after(() => { request.destroy(); });
  request.end(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'software_window' } }));
  const signal = await started;
  assert.ok(signal instanceof AbortSignal);
  request.destroy();
  assert.equal(await finished, true);
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createBrowserAutomationBridge } = require('../../src/app/backend/services/browser-automation-bridge');
const { registerExternalMcpConfigIpc } = require('../../src/app/backend/features/browser/register-external-mcp-config-ipc');

function bindMcpConfig(bridge) {
  const handlers = new Map();
  const frame = { url: 'file:///app/src/app/frontend/views/app-shell.html' };
  const sender = { mainFrame: frame, isDestroyed: () => false };
  let text = '';
  const ipc = { handle: (name, handler) => handlers.set(name, handler) };
  registerExternalMcpConfigIpc(ipc, {
    browserAutomationBridge: bridge,
    ui: { getMainWindow: () => ({ webContents: sender }) },
  }, (value) => { text = value; });
  return {
    status: (event = { sender, senderFrame: frame }) => handlers.get('get-external-codex-status')(event),
    copy: (event = { sender, senderFrame: frame }) => handlers.get('copy-external-codex-config')(event),
    config: () => JSON.parse(text),
  };
}

async function reservePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('automation bridge exposes authenticated external MCP without a legacy extension connection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-bridge-external-mcp-'));
  const descriptorPath = path.join(root, 'ai-free-mcp-bridge.json');
  const port = await reservePort();
  const bridge = createBrowserAutomationBridge({
    cardCacheDir: path.join(root, 'cards'),
    externalMcpDescriptorPath: descriptorPath,
    getExternalMcpAccess: () => true,
    logger: { log() {}, warn() {} },
    port,
  });
  const executed = [];
  bridge.configureExternalMcp({
    getConnections: () => [],
    getWindowTools: () => ({
      tools: [{ name: 'software_window', description: '管理窗口', input_schema: { type: 'object', properties: { action: { type: 'string' } } } }],
      has: (name) => name === 'software_window',
      execute: async (name, args) => {
        executed.push({ name, args });
        return { success: true, total: 0, items: [] };
      },
    }),
  });
  try {
    const configIpc = bindMcpConfig(bridge);
    assert.equal((await configIpc.copy()).ok, false);
    await bridge.start();
    assert.equal((await configIpc.copy({ sender: {}, senderFrame: {} })).ok, false);
    const sidebarFrame = { url: 'file:///app/src/app/frontend/sidebar/ai-control.html' };
    const sidebarEvent = { sender: { mainFrame: sidebarFrame }, senderFrame: sidebarFrame };
    assert.equal((await configIpc.copy(sidebarEvent)).ok, false);
    assert.equal((await configIpc.status(sidebarEvent)).ok, false);
    assert.deepEqual(await configIpc.copy(), { ok: true, data: { mode: 'streamable-http' } });
    const { url, method, headers: requestHeaders, transport } = configIpc.config().streamableHttp;
    assert.equal(transport, 'streamable-http');
    assert.equal(method, 'POST');
    assert.equal(new URL(url).origin, `http://127.0.0.1:${port}`);
    assert.equal(requestHeaders.Accept, 'application/json, text/event-stream');
    const post = (message) => fetch(url, {
      method, headers: requestHeaders, body: JSON.stringify({ jsonrpc: '2.0', ...message }),
    });
    const initialized = await post({ id: 1, method: 'initialize' });
    assert.equal(initialized.status, 200);
    assert.equal((await initialized.json()).result.serverInfo.name, 'ai-free');
    assert.equal((await post({ method: 'notifications/initialized' })).status, 202);
    const tools = await post({ id: 2, method: 'tools/list' });
    assert.equal(tools.status, 200);
    assert.deepEqual((await tools.json()).result.tools.map(({ name }) => name), ['browser_control', 'manage_card', 'software_window']);
    const callCard = async (id, args) => (await (await post({ id, method: 'tools/call',
      params: { name: 'manage_card', arguments: args },
    })).json()).result.structuredContent;
    const created = await callCard(3, { action: 'write', cardData: { name: 'Offline HTTP fixture', steps: [{ type: 'end' }] } });
    assert.ok(created.item.id);
    assert.equal((await callCard(4, { action: 'get', id: created.item.id })).item.id, created.item.id);
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
    assert.equal(JSON.stringify(await configIpc.status()).includes(descriptor.token), false);
    const headers = { 'x-ai-free-mcp-token': descriptor.token };
    const listedResponse = await fetch(`${descriptor.endpoint}/mcp/v1/tools`, { headers });
    assert.equal(listedResponse.status, 200);
    const listed = await listedResponse.json();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ['browser_control', 'manage_card', 'software_window']);

    const calledResponse = await fetch(`${descriptor.endpoint}/mcp/v1/call`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'software_window', arguments: { action: 'list' } }),
    });
    assert.equal(calledResponse.status, 200);
    const called = await calledResponse.json();
    assert.equal(called.result.total, 0);
    assert.deepEqual(executed, [{ name: 'software_window', args: { action: 'list' } }]);
  } finally {
    await bridge.stop();
    assert.equal(fs.existsSync(descriptorPath), false);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('external MCP reports VIP requirement while calls follow live membership access', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-bridge-external-mcp-vip-'));
  const descriptorPath = path.join(root, 'ai-free-mcp-bridge.json');
  fs.writeFileSync(descriptorPath, JSON.stringify({ pid: 1, token: 'stale' }), 'utf8');
  const port = await reservePort();
  let isVip = false;
  const bridge = createBrowserAutomationBridge({
    cardCacheDir: path.join(root, 'cards'),
    externalMcpDescriptorPath: descriptorPath,
    getExternalMcpAccess: () => ({ isVip }),
    logger: { log() {}, warn() {} },
    port,
  });
  bridge.configureExternalMcp({
    getConnections: () => [],
    getWindowTools: () => ({
      tools: [{ name: 'software_window', description: '管理窗口', input_schema: { type: 'object', properties: { action: { type: 'string' } } } }],
      has: (name) => name === 'software_window',
      execute: async () => ({ success: true, total: 0, items: [] }),
    }),
  });
  try {
    await bridge.start();
    const configIpc = bindMcpConfig(bridge);
    assert.equal((await configIpc.copy()).ok, false);
    assert.equal(fs.existsSync(descriptorPath), true);
    const freeDescriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
    const freeHeaders = { 'x-ai-free-mcp-token': freeDescriptor.token };
    const freeStatus = await fetch(`${freeDescriptor.endpoint}/mcp/v1/status`, { headers: freeHeaders });
    assert.equal(freeStatus.status, 200);
    assert.equal((await freeStatus.json()).membershipRequired, true);
    const freeTools = await fetch(`${freeDescriptor.endpoint}/mcp/v1/tools`, { headers: freeHeaders });
    assert.equal(freeTools.status, 403);
    assert.equal((await freeTools.json()).error, 'AI_FREE_MCP_VIP_REQUIRED');

    isVip = true;
    assert.equal(bridge.refreshExternalMcpAccess(), true);
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
    assert.notEqual(descriptor.token, freeDescriptor.token);
    assert.equal((await configIpc.copy()).ok, true);
    assert.equal(configIpc.config().streamableHttp.headers.Authorization === `Bearer ${descriptor.token}`, true);
    const headers = { 'x-ai-free-mcp-token': descriptor.token };
    const memberStatus = await fetch(`${descriptor.endpoint}/mcp/v1/status`, { headers });
    assert.equal(memberStatus.status, 200);
    assert.equal((await memberStatus.json()).membershipRequired, false);

    isVip = false;
    assert.equal(bridge.refreshExternalMcpAccess(), true);
    assert.equal((await configIpc.copy()).ok, false);
    assert.equal(fs.existsSync(descriptorPath), true);
    const denied = await fetch(`${descriptor.endpoint}/mcp/v1/status`, { headers });
    assert.equal(denied.status, 401);

    const revoked = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
    const revokedHeaders = { 'x-ai-free-mcp-token': revoked.token };
    const revokedStatus = await fetch(`${revoked.endpoint}/mcp/v1/status`, { headers: revokedHeaders });
    assert.equal(revokedStatus.status, 200);
    assert.equal((await revokedStatus.json()).membershipRequired, true);
    const revokedCall = await fetch(`${revoked.endpoint}/mcp/v1/call`, {
      method: 'POST',
      headers: { ...revokedHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'software_window', arguments: { action: 'list' } }),
    });
    assert.equal(revokedCall.status, 403);
    assert.equal((await revokedCall.json()).error, 'AI_FREE_MCP_VIP_REQUIRED');
  } finally {
    await bridge.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

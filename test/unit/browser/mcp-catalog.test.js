'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createAiChatService } = require('../../../src/app/backend/features/ai-chat/ai-chat-service');
const { registerMcpCatalogIpc } = require('../../../src/app/backend/features/browser/register-mcp-catalog-ipc');

function fixture(isDevMode) {
  const mainFrame = { url: 'file:///app/src/app/frontend/views/app-shell.html?dev=1' };
  const webContents = { mainFrame, isDestroyed: () => false };
  const { getWindowTools } = createAiChatService({ browserWindowUi: { getTabs: () => new Map() }, aiSandboxDir: process.cwd() });
  let handle;
  let online = false;
  registerMcpCatalogIpc({ handle(_channel, callback) { handle = callback; } }, {
    isDevMode, getMainWindow: () => ({ webContents }), getWindowTools,
    browserAutomationBridge: { listConnections: () => online ? [{ id: 'fixture-profile' }] : [] },
  });
  return { handle, event: { sender: webContents, senderFrame: mainFrame }, connect: () => { online = true; } };
}

test('MCP 目录拒绝普通模式、侧栏和非主帧，即使 URL 带开发模式参数', () => {
  const normal = fixture(false);
  assert.equal(normal.handle(normal.event).error.code, 'DEV_MODE_REQUIRED');
  const { handle, event } = fixture(true);
  assert.equal(handle({ ...event, sender: {} }).error.code, 'DEV_MODE_REQUIRED');
  assert.equal(handle({ ...event, senderFrame: { ...event.senderFrame } }).error.code, 'DEV_MODE_REQUIRED');
  event.senderFrame.url = 'file:///app/src/app/frontend/sidebar/ai-control.html?dev=1';
  assert.equal(handle(event).error.code, 'DEV_MODE_REQUIRED');
});

test('目录提供当前工具的参数、提示词、模拟协议返回和连接状态', () => {
  const { handle, event, connect } = fixture(true);
  const result = handle(event);
  assert.equal(result.ok, true);
  const { tools } = result.data;
  assert.equal(new Set(tools.map(({ name }) => name)).size, tools.length);
  assert.ok(tools.some(({ name }) => name === 'browser_page_batch'));
  for (const { name, inputSchema, sample } of tools) {
    assert.ok(sample.prompt);
    assert.equal(sample.request.params.name, name);
    for (const arg of Object.keys(sample.request.params.arguments)) assert.ok(Object.hasOwn(inputSchema.properties, arg));
    const { structuredContent, content } = sample.response.result;
    assert.deepEqual(JSON.parse(content[0].text), structuredContent);
  }
  const observe = (entries) => entries.find((tool) => tool.name === 'browser_observe');
  assert.equal(observe(tools).availability, '等待 Chromium 连接');
  connect();
  assert.equal(observe(handle(event).data.tools).availability, 'Chromium 已连接');
  assert.doesNotMatch(JSON.stringify(handle(event)), /fixture-profile/);
});

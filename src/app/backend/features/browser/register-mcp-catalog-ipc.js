'use strict';

const { AppError, fail, ok } = require('../../../contracts/ipc-result');
const { isHomeSender } = require('../window/home-dev-sender');
const { NATIVE_BROWSER_TOOL_DEFINITIONS } = require('../../services/native-browser-tool-definitions');
const { addBrowserRouting, normalizeSchema } = require('../../services/browser-automation-external-gateway');
const { mcpToolResult } = require('../../services/mcp-tool-result');
const examples = require('./mcp-catalog-examples');

function toolDetails(tool, availability, inputSchema = normalizeSchema(tool)) {
  const { name, description } = tool;
  const sample = examples[name];
  const details = { name, description, inputSchema, availability };
  if (!sample) return details;
  const [prompt, args, output, note] = sample;
  return {
    ...details,
    sample: {
      prompt,
      request: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      response: { jsonrpc: '2.0', id: 1, result: mcpToolResult(output) },
      note,
    },
  };
}

function registerMcpCatalogIpc(ipc, { isDevMode, getMainWindow, getWindowTools, browserAutomationBridge }) {
  return ipc.handle('get-browser-mcp-catalog', (event) => {
    if (!isDevMode || !isHomeSender(event, getMainWindow()?.webContents)) {
      return fail(new AppError('DEV_MODE_REQUIRED', 'MCP 工具目录仅在开发者模式的首页可用'));
    }
    const hasBrowser = Boolean(browserAutomationBridge?.listConnections().length);
    const tools = (getWindowTools()?.tools || []).map((tool) =>
      toolDetails(tool, tool.name === 'browser_environment' ? '按对话需要提供' : '无需连接 Chromium'));
    tools.push(...NATIVE_BROWSER_TOOL_DEFINITIONS.map((tool) => toolDetails(tool,
      tool.name === 'browser_control' ? '总览无需连接 Chromium'
        : (hasBrowser ? 'Chromium 已连接' : '等待 Chromium 连接'), addBrowserRouting(tool).inputSchema)));
    return ok({ tools });
  });
}

module.exports = { registerMcpCatalogIpc };

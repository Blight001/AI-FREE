'use strict';

const {
  resolveBrowserConnection,
  resolveDispatchTimeout,
  sanitizeBrowserRoutingArgs,
} = require('./automation-tool-contract');

const BLOCKED_CARD_TOOLS = new Set(['manage_card']);
const CODEX_AIFREE_MARKER = '__aifree_';

function text(value) { return String(value == null ? '' : value).trim(); }

function normalizeCardToolName(value) {
  const raw = text(value);
  if (!raw) return '';
  if (raw.startsWith('mcp__')) {
    const markerIndex = raw.lastIndexOf(CODEX_AIFREE_MARKER);
    if (markerIndex >= 0) return raw.slice(markerIndex + CODEX_AIFREE_MARKER.length).replace(/[-+.]+/g, '_');
  }
  if (raw.startsWith('aifree.')) return raw.slice('aifree.'.length).replace(/[-+.]+/g, '_');
  if (raw.startsWith('aifree_')) return raw.slice('aifree_'.length).replace(/[-+.]+/g, '_');
  return raw;
}

function toolDefinition(source = {}) {
  const name = normalizeCardToolName(source.name);
  if (!name || BLOCKED_CARD_TOOLS.has(name)) return null;
  return {
    name,
    description: text(source.description),
    destructive: source.destructive === true,
    input_schema: source.input_schema || source.inputSchema || { type: 'object', properties: {} },
  };
}

function routeError(resolved) {
  if (resolved.kind === 'ambiguous') return `存在多个名为「${resolved.reference}」的浏览器，请使用连接 ID`;
  if (resolved.kind === 'not_found') return `未找到 AI-FREE 浏览器窗口: ${resolved.reference}`;
  if (resolved.kind === 'unavailable') return '当前没有已连接 MCP 的 AI-FREE 浏览器窗口';
  return '当前有多个浏览器窗口，请在 MCP 参数 change_browser 中指定目标';
}

class AutomationCardMcpRouter {
  constructor(options = {}) {
    this.listConnections = options.listConnections || (() => []);
    this.getConnection = options.getConnection || (() => null);
    this.dispatch = options.dispatch;
    this.getWindowTools = () => null;
  }

  configure(context = {}) {
    if (typeof context.getWindowTools === 'function') this.getWindowTools = context.getWindowTools;
  }

  listTools() {
    const tools = new Map();
    for (const source of this.getWindowTools()?.tools || []) {
      const tool = toolDefinition(source);
      if (tool) tools.set(tool.name, tool);
    }
    for (const connection of this.listConnections()) {
      const full = this.getConnection(connection.id);
      for (const source of full?.tools || []) {
        const tool = toolDefinition(source);
        if (tool && !tools.has(tool.name)) tools.set(tool.name, tool);
      }
    }
    return Array.from(tools.values());
  }

  requireBrowserTool(connection, toolName) {
    const tools = this.getConnection(connection.id)?.tools || [];
    if (tools.some((tool) => normalizeCardToolName(tool?.name) === toolName)) return;
    throw new Error(`窗口「${text(connection.name) || connection.id}」不支持 MCP 工具: ${toolName}`);
  }

  async execute(defaultConnectionId, name, rawArgs = {}, options = {}) {
    const toolName = normalizeCardToolName(name);
    if (!toolName) throw new Error('MCP 步骤缺少 tool');
    if (BLOCKED_CARD_TOOLS.has(toolName)) throw new Error(`自动化卡片禁止递归调用 ${toolName}`);
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? { ...rawArgs } : {};
    const windowTools = this.getWindowTools();
    if (windowTools?.has?.(toolName)) return windowTools.execute(toolName, args);

    const connections = this.listConnections();
    const resolved = resolveBrowserConnection(connections, args, defaultConnectionId);
    if (resolved.kind !== 'found') throw new Error(routeError(resolved));
    this.requireBrowserTool(resolved.connection, toolName);
    const timeoutMs = resolveDispatchTimeout(toolName, args);
    return this.dispatch(
      resolved.connection.id,
      toolName,
      sanitizeBrowserRoutingArgs(args),
      { ...options, timeoutMs },
    );
  }
}

function createAutomationCardMcpRouter(options) { return new AutomationCardMcpRouter(options); }

module.exports = { BLOCKED_CARD_TOOLS, createAutomationCardMcpRouter };

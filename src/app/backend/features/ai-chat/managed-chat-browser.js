'use strict';

const { AppError } = require('../../../contracts/ipc-result');
const path = require('node:path');
const { findConnectionByReference, isBrowserOverview } = require('../../services/automation-tool-contract');
const { sameBrowserInstance } = require('../../services/automation-card-contract');
const { PAGE_BATCH_TOOL } = require('../../services/browser-page-batch');
const { routeFailure } = require('./chat-browser-target');

const PAGE_TOOLS = new Set(['browser_control', 'browser_tab', 'browser_observe', 'browser_action',
  'browser_wait', PAGE_BATCH_TOOL.name, 'browser_file', 'browser_screenshot', 'browser_media']);

function chooseManagedBrowser(scope, reference) {
  if (!reference) return null;
  if (!scope) throw new AppError('CHAT_BROWSER_FORBIDDEN', '此入口无法向子任务授予浏览器连接');
  const connection = findConnectionByReference(scope.connections, reference);
  if (connection.kind !== 'found') {
    throw new AppError('CHAT_BROWSER_NOT_FOUND', '请指定父对话可用的在线浏览器连接 ID 或唯一名称');
  }
  const { id, name, browserProcessId, connectedAt } = connection.connection;
  return { id, name, browserProcessId, connectedAt,
    ...(Array.isArray(scope.allowedOrigins) && { allowedOrigins: scope.allowedOrigins }),
    ...(scope.allowedWorkspaceDirectory && { allowedWorkspaceDirectory: scope.allowedWorkspaceDirectory }),
    ...(scope.workspaceRoot && { workspaceRoot: scope.workspaceRoot }) };
}

function scopedBrowserTool(tool) {
  if (tool.name !== 'browser_control') return tool;
  const { action, ...properties } = tool.input_schema.properties;
  return { ...tool, description: '查看、接管或释放子任务获授权的浏览器。', input_schema: {
    ...tool.input_schema, properties: { ...properties, action: { ...action, enum: ['status', 'acquire', 'release'] } },
  } };
}

function allowedOrigin(grant, url) {
  try { return Array.isArray(grant.allowedOrigins) && grant.allowedOrigins.includes(new URL(url).origin); } catch (_) { return false; }
}

function allowedWorkspacePath(grant, candidate) {
  const workspace = path.resolve(grant.workspaceRoot || '');
  const root = path.resolve(workspace, grant.allowedWorkspaceDirectory || '');
  const target = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(workspace, candidate);
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function allowedBenchmarkFile(grant, args) {
  if (!['download', 'download_element', 'upload'].includes(args.action)) return false;
  if (args.url && !allowedOrigin(grant, args.url)) return false;
  if (['download', 'download_element'].includes(args.action) && !args.directory) return false;
  const candidates = [args.path, ...(Array.isArray(args.paths) ? args.paths : []), args.directory].filter(Boolean);
  return candidates.length > 0 && candidates.every((candidate) => allowedWorkspacePath(grant, candidate));
}

function isAllowedBenchmarkTarget(grant, tool, args) {
  if (!grant.allowedOrigins && !grant.allowedWorkspaceDirectory) return true;
  if (tool === 'browser_page_batch') return false;
  if (tool === 'browser_tab') return args.action === 'list'
    || (args.action === 'navigate' && allowedOrigin(grant, args.url));
  if (tool === 'browser_file') {
    if (args.page_url && !allowedOrigin(grant, args.page_url)) return false;
    return allowedBenchmarkFile(grant, args);
  }
  if (tool === 'browser_media') return false;
  return true;
}

function managedBrowserContext(bridge, grant) {
  if (!grant) return { connections: [], controlledConnectionId: '', localInteraction: false };
  const lookup = (id) => {
    if (id !== grant.id) return null;
    const current = bridge?.getConnection?.(id);
    return sameBrowserInstance(grant, current) ? current : null;
  };
  const connection = lookup(grant.id);
  if (!connection) return { error: '获授权的浏览器已离线或重启。请重新安排任务并核对页面状态。' };
  const tools = (connection.tools || []).filter(({ name }) => PAGE_TOOLS.has(name)).map(scopedBrowserTool);
  return { connections: [{ ...connection, name: grant.name || connection.name, tools }], controlledConnectionId: grant.id,
    localInteraction: true, bridge: {
      getConnection: lookup,
      dispatch(id, tool, args, options) {
        options?.signal?.throwIfAborted();
        if (!lookup(id)) return routeFailure('BROWSER_TARGET_CHANGED', '获授权的浏览器已离线或重启');
        if (!PAGE_TOOLS.has(tool) || isBrowserOverview(tool, args)) {
          return routeFailure('CHAT_BROWSER_FORBIDDEN', '子任务只可操作获授权的浏览器');
        }
        if (!isAllowedBenchmarkTarget(grant, tool, args)) {
          return routeFailure('CHAT_BROWSER_FORBIDDEN', 'MCP 基准任务仅可访问本地测试页和本轮临时文件');
        }
        return bridge.dispatch(id, tool, args, options);
      },
    } };
}

module.exports = { chooseManagedBrowser, isAllowedBenchmarkTarget, managedBrowserContext, PAGE_TOOLS };

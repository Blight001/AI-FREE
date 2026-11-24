'use strict';

const { AppError } = require('../../../contracts/ipc-result');
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
  return { id, name, browserProcessId, connectedAt };
}

function scopedBrowserTool(tool) {
  if (tool.name !== 'browser_control') return tool;
  const { action, ...properties } = tool.input_schema.properties;
  return { ...tool, description: '查看、接管或释放子任务获授权的浏览器。', input_schema: {
    ...tool.input_schema, properties: { ...properties, action: { ...action, enum: ['status', 'acquire', 'release'] } },
  } };
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
        return bridge.dispatch(id, tool, args, options);
      },
    } };
}

module.exports = { chooseManagedBrowser, managedBrowserContext, PAGE_TOOLS };

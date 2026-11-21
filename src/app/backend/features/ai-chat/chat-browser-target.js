'use strict';

const { randomUUID } = require('node:crypto');

const PAGE_TOOLS = new Set(['browser_action', 'browser_observe', 'browser_wait',
  'browser_screenshot', 'browser_file', 'browser_media']);
const text = (value) => String(value ?? '').trim();

function chatError(code, message) {
  return { ok: false, error: { code, message, retryable: false } };
}

function routeFailure(errorCode, error) {
  return { success: false, errorCode, error, actionExecuted: false, recoverable: false };
}

function displayHost(value) {
  try { return new URL(value).host; } catch (_) { return ''; }
}

async function captureChatTarget(bridge, connectionId) {
  const connection = bridge?.getConnection?.(connectionId);
  if (!connection) return chatError('BROWSER_ROUTE_NOT_FOUND', '所选浏览器已离线，请重新选择');
  const result = await bridge.dispatch(connectionId, 'browser_tab', { action: 'list' }, { timeoutMs: 5000 });
  return readChatTarget(connection, connectionId, result?.activeTab);
}

function readChatTarget(connection, connectionId, tab) {
  if (!text(tab?.pageToken)) return chatError('BROWSER_TARGET_UNAVAILABLE', '无法识别当前页面，请确认标签已加载并使用支持页面校验的内核');
  return { ok: true, data: {
    connectionId, pageToken: text(tab.pageToken), url: text(tab.url), title: text(tab.title).slice(0, 200),
    host: displayHost(tab.url), browserName: text(connection.name).slice(0, 120),
  } };
}

function browserMetadataTool(toolName, args) {
  const action = text(args.action).toLowerCase();
  return (toolName === 'browser_tab' && action === 'list')
    || (toolName === 'browser_control' && ['overview', 'status', 'release'].includes(action || 'status'));
}

function explicitTabChange(toolName, args) {
  if (toolName !== 'browser_tab') return false;
  const action = text(args.action).toLowerCase();
  if (action === 'switch') {
    const index = args.index ?? args.tab_index ?? args.id ?? args.tab_id ?? args.tabId;
    return Boolean(text(index) || text(args.url));
  }
  return action === 'navigate' && ![args.replace_current, args.current_tab, args.same_tab].includes(true);
}

function guardedBrowserRoute(context, toolName, args) {
  if (!context.localInteraction || browserMetadataTool(toolName, args) || explicitTabChange(toolName, args)) return null;
  const action = text(args.action).toLowerCase();
  if (PAGE_TOOLS.has(toolName) && (!args.surface || args.surface === 'page')) return null;
  if (toolName === 'browser_control' && action === 'acquire') return null;
  return routeFailure('BROWSER_TARGET_TOOL_UNSUPPORTED', '侧栏只支持受校验的页面操作、指定标签切换和新标签导航');
}

async function resolvePageGuard(context, connection) {
  const cached = context.browserTargets.get(connection.id);
  if (cached?.pageToken) return { ok: true, data: cached };
  const target = await captureChatTarget(context.bridge, connection.id);
  if (!target.ok) return target;
  if (cached?.url && cached.url !== target.data.url) {
    return chatError('BROWSER_TARGET_CHANGED', '活动标签已变化，请先列出标签并核对目标');
  }
  context.browserTargets.set(connection.id, target.data);
  return target;
}

function withoutPageToken(tab) {
  if (!tab || typeof tab !== 'object') return tab;
  const { pageToken: _pageToken, ...publicTab } = tab;
  return publicTab;
}

function recordChatTabResult(context, connection, args, result) {
  if (!result || result.success === false || result.ok === false) return result;
  const { id } = connection;
  if (explicitTabChange('browser_tab', args)) {
    // Start a new page sequence at the document or URL returned by the tab operation.
    const target = readChatTarget(connection, id, result);
    const url = text(result.url);
    if (target.ok) context.browserTargets.set(id, target.data);
    else if (url) context.browserTargets.set(id, { url });
    else context.browserTargets.delete(id);
    return withoutPageToken(result);
  }
  const target = readChatTarget(connection, id, result.activeTab);
  const previous = context.browserTargets.get(id);
  if (target.ok && (!previous || (!previous.pageToken && previous.url === target.data.url))) {
    context.browserTargets.set(id, target.data);
  }
  return { ...result, activeTab: withoutPageToken(result.activeTab),
    ...(Array.isArray(result.tabs) ? { tabs: result.tabs.map(withoutPageToken) } : {}) };
}

function createChatApproval(signal) {
  let pending = null;
  function finish(accepted) {
    if (!pending) return false;
    const { resolve, timer } = pending;
    pending = null;
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    resolve(accepted);
    return true;
  }
  const cancel = () => finish(false);
  return {
    request(id, notify) {
      if (pending || signal.aborted) return Promise.resolve(false);
      return new Promise((resolve) => {
        pending = { id, resolve, timer: setTimeout(cancel, 60000) };
        signal.addEventListener('abort', cancel, { once: true });
        try { notify(); } catch (error) { cancel(); void error; }
      });
    },
    decide: (id, accepted) => pending?.id === id && finish(accepted),
    cancel,
  };
}

async function confirmBrowserUpload(context, files) {
  if (!context.approval || !context.boundTarget) return false;
  const id = randomUUID();
  const { title, host, browserName } = context.boundTarget;
  const accepted = await context.approval.request(id, () => context.emit({
    type: 'upload_confirmation', id, files, title, host, browserName,
  }));
  context.emit({ type: 'upload_confirmation_closed', id });
  return accepted && !context.signal?.aborted;
}

module.exports = {
  browserMetadataTool, captureChatTarget, chatError, confirmBrowserUpload, createChatApproval,
  guardedBrowserRoute, recordChatTabResult, resolvePageGuard, routeFailure,
};

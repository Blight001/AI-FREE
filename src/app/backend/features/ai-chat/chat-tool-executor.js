'use strict';

const { collectConnectionTools } = require('./chat-tool-context');
const { browserSessionTool, guardedBrowserRoute, recordChatTabResult, resolvePageGuard, routeFailure } = require('./chat-browser-target');
const { PAGE_BATCH_TOOL, executeChatPageBatch } = require('./chat-page-batch');
const { dispatchChatUpload } = require('./chat-browser-upload');
const { recoverChatUpload } = require('./chat-upload-recovery');
const { commandMetadata, executeLocalCommand, isLocalCommand, visibleCommandOutput } = require('./chat-local-command');
const { createDownloadArtifact, verifyWorkspaceArtifactSync } = require('./ai-workspace-service');
const { mcpToolResult } = require('../../services/mcp-tool-result');
const {
  browserReference,
  normalizeToolError,
  resolveBrowserConnection,
  resolveDispatchTimeout,
  sanitizeBrowserRoutingArgs,
} = require('../../services/automation-tool-contract');

function parseToolArguments(call) {
  const raw = String(call?.function?.arguments || '{}');
  try {
    const args = JSON.parse(raw);
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { args: {}, error: 'arguments 必须是 JSON 对象' };
    }
    return { args, error: '' };
  } catch (_) {
    return { args: {}, error: 'arguments 不是有效的 JSON' };
  }
}

function resolvePluginTarget(args, connections, describeConnections, controlledConnectionId = '') {
  const resolved = resolveBrowserConnection(connections, args, controlledConnectionId);
  if (resolved.kind === 'found') return { connection: resolved.connection };
  if (resolved.kind === 'ambiguous') {
    return { error: `存在多个名为 ${JSON.stringify(resolved.reference)} 的浏览器，请在 change_browser 中传连接 ID：${describeConnections()}` };
  }
  if (resolved.kind === 'not_found') {
    return { error: `未在在线浏览器中找到 ${JSON.stringify(resolved.reference)}。`
        + `windows_tab 的 history_id/tab_id 不能代替 change_browser；可用浏览器：${describeConnections()}` };
  }
  return { error: `当前没有唯一的控制浏览器，请通过 change_browser 指定目标（连接 ID 或名称）：${describeConnections()}` };
}

async function dispatchPluginTool(context, toolName, args) {
  const target = resolvePluginTarget(
    args,
    context.connections,
    context.describeConnections,
    context.browserControl?.connectionId,
  );
  if (target.error) {
    return { success: false, error: target.error, errorCode: 'BROWSER_ROUTE_NOT_FOUND', phase: 'tool_route', tool: toolName };
  }
  const dispatchArgs = /** @type {Record<string, any>} */ (sanitizeBrowserRoutingArgs(args));
  const pageBatch = toolName === PAGE_BATCH_TOOL.name;
  if (pageBatch && !context.localInteraction) return routeFailure('BROWSER_TARGET_TOOL_UNSUPPORTED', '页面批处理仅在 AI 控制侧栏可用');
  const blocked = pageBatch ? null : guardedBrowserRoute(context, toolName, dispatchArgs);
  if (blocked) return blocked;
  if (context.browserControl && context.browserControl.connectionId !== target.connection.id) {
    context.browserControl.connectionId = target.connection.id;
    context.emit?.({ type: 'browser_control_changed', connectionId: target.connection.id, name: target.connection.name || '' });
  }
  return dispatchSelectedBrowser(context, target.connection, toolName, dispatchArgs, resolveDispatchTimeout(toolName, args));
}

async function dispatchSelectedBrowser(context, connection, toolName, args, timeoutMs) {
  const local = context.localInteraction;
  const guardRequired = local && toolName !== 'browser_tab' && !browserSessionTool(toolName, args);
  const target = guardRequired ? await context.waitForAbort(resolvePageGuard(context, connection, toolName, args)) : null;
  if (target && !target.ok) return routeFailure(target.error.code, target.error.message);
  const guard = target?.data;
  const dispatch = (input, name = toolName) => context.bridge.dispatch(connection.id, name, input, {
    timeoutMs, allowAppSurface: !local, signal: context.signal,
    ...(guard ? { expectedPageToken: guard.pageToken } : {}),
  });
  if (toolName === PAGE_BATCH_TOOL.name) {
    return executeChatPageBatch(context, connection, args, dispatch);
  }
  if (local && toolName === 'browser_file' && String(args.action).trim().toLowerCase() === 'upload') {
    const result = await dispatchChatUpload({ ...context, boundTarget: guard }, connection.id, args, dispatch);
    return recoverChatUpload(context, guard, result);
  }
  const result = await context.waitForAbort(dispatch(args));
  return local && toolName === 'browser_tab' ? recordChatTabResult(context, connection, args, result) : result;
}

function normalizeToolFailure(error, toolName) {
  const normalized = normalizeToolError(error, {
    code: 'BROWSER_TOOL_FAILED',
    message: '浏览器工具执行失败',
    phase: 'tool_dispatch',
    retryable: true,
  });
  return {
    success: false,
    error: normalized.message,
    errorReason: normalized.message,
    errorCode: normalized.code,
    phase: normalized.phase,
    recoverable: normalized.retryable,
    tool: String(error?.tool || toolName),
    ...(normalized.timeoutMs ? { timeoutMs: normalized.timeoutMs } : {}),
  };
}

function prepareToolResult(toolResult, toolName) {
  const failed = toolResult?.success === false || toolResult?.ok === false;
  if (!failed) return { failed: false, result: toolResult, failure: '' };
  const failure = String(toolResult?.error || toolResult?.message || `${toolName} 执行失败`);
  return {
    failed: true,
    failure,
    result: {
      ...(toolResult && typeof toolResult === 'object' ? toolResult : {}),
      success: false,
      error: failure,
      recoverable: toolResult?.recoverable !== false,
      instruction: toolResult?.recoverable === false
        ? '向用户报告此结果，不要自动重试该操作。'
        : '本次工具操作失败。请根据错误调整参数或向用户说明。',
    },
  };
}

function findConnectionByName(connections, name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;
  return connections.find((item) => String(item?.name || '').trim().toLowerCase() === wanted) || null;
}

function nextWindowControl(context, action, resultName) {
  const current = context.connections.find((item) => item?.id === context.browserControl.connectionId) || null;
  const matched = findConnectionByName(context.connections, resultName);
  if (['open', 'create'].includes(action)) return matched || current;
  if (action === 'close' && matched?.id === current?.id) {
    return context.connections.find((item) => item?.id !== matched.id) || null;
  }
  return current;
}

function appendReadyConnectionTools(context, connection) {
  if (!Array.isArray(context.toolDefinitions)) return;
  const known = new Set(context.toolDefinitions.map((tool) => String(tool?.name || '')));
  const ready = collectConnectionTools([connection], context.windowTools, context.localInteraction);
  context.toolDefinitions.push(...ready.filter((tool) => !known.has(tool.name)));
}

function readyWindowConnection(context, toolResult) {
  const id = String(toolResult?.control_browser_id || '').trim();
  if (!id) return null;
  const existing = context.connections.find((item) => String(item?.id || '') === id);
  const live = existing || context.bridge?.getConnection?.(id);
  if (!live) return null;
  const connection = existing || {
    ...live, name: String(toolResult?.control_browser_name || live.name || '').trim(),
  };
  if (!existing) context.connections.push(connection);
  appendReadyConnectionTools(context, connection);
  return connection;
}

function syncWindowToolControl(context, toolName, args, toolResult) {
  if (!['windows_tab', 'software_window'].includes(toolName) || toolResult?.success === false || !context.browserControl) return;
  const action = String(args?.action || '').trim().toLowerCase();
  const next = readyWindowConnection(context, toolResult)
    || nextWindowControl(context, action, toolResult?.name);
  if (!next || next.id === context.browserControl.connectionId) return;
  context.browserControl.connectionId = next.id;
  context.emit?.({ type: 'browser_control_changed', connectionId: next.id, name: next.name || '' });
}

function isPreviewImageResult(toolName, result) {
  if (!result || result.success === false) return false;
  if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(String(result.dataUrl || ''))) return false;
  return ['browser_screenshot', 'browser_observe', 'browser_action'].includes(toolName) || result.send_to_user === true;
}

function buildToolImageMessage(toolName, toolCallId, urls) {
  return {
    // OpenAI-compatible chat endpoints accept image_url in the user envelope.
    role: 'user',
    content: [
      { type: 'text', text: `[工具图像数据] ${toolName}（调用 ${toolCallId}）返回的图像数据，顺序与工具结果中的图片标签一致。` },
      ...urls.map((url) => ({ type: 'image_url', image_url: { url } })),
    ],
    ai_free_transient_image: true,
    ai_free_tool_call_id: toolCallId,
  };
}

function serializeToolResult(result, toolName, toolCallId) {
  let serializedResult = result ?? null;
  let imageUrls = [];
  if (Array.isArray(result?.images) || result?.observation?.dataUrl) {
    const converted = mcpToolResult(result);
    serializedResult = converted.structuredContent;
    imageUrls = converted.content.filter((item) => item.type === 'image')
      .map((item) => `data:${item.mimeType};base64,${item.data}`);
  }
  if (!imageUrls.length && isPreviewImageResult(toolName, result)) {
    const { dataUrl, ...metadata } = result;
    serializedResult = { ...metadata, image_attached: true };
    imageUrls = [dataUrl];
  }
  const imageMessage = imageUrls.length ? buildToolImageMessage(toolName, toolCallId, imageUrls) : null;
  try { return { content: JSON.stringify(serializedResult), failure: '', imageMessage }; } catch (_) {
    const failure = `${toolName} 返回了无法序列化的结果`;
    return {
      content: JSON.stringify({ success: false, error: failure, recoverable: true }),
      failure,
      imageMessage: null,
    };
  }
}

function compactToolActivityResult(context, result, toolName) {
  if (Array.isArray(result?.images) || result?.observation?.dataUrl) return context.compactToolValue(mcpToolResult(result).structuredContent);
  if (isPreviewImageResult(toolName, result) || (toolName === 'browser_screenshot' && result?.dataUrl)) {
    const { dataUrl: _dataUrl, ...metadata } = result;
    return context.compactToolValue({ ...metadata, image_attached: true });
  }
  return context.compactToolValue(result ?? null);
}

function appendPendingImage(context, imageMessage) {
  if (imageMessage) context.pendingImageMessages?.push(imageMessage);
}

function executeChatTool(context, activity, args) {
  if (activity.name === PAGE_BATCH_TOOL.name) {
    const reportBatchProgress = (progress) => context.emit({
      type: 'tool_progress', tool: { id: activity.id, name: activity.name, progress }, round: context.round,
    });
    return dispatchPluginTool({ ...context, reportBatchProgress }, activity.name, args);
  }
  if (!context.windowTools?.has(activity.name)) return dispatchPluginTool(context, activity.name, args);
  if (isLocalCommand(activity.name)) return executeLocalCommand(context, activity, args);
  return context.waitForAbort(context.windowTools.execute(activity.name, args, { signal: context.signal }));
}

function publishCompletedActivity(context, activity, result, startedAt, failed) {
  activity.status = failed ? 'error' : 'success';
  activity.duration_ms = Math.max(0, Date.now() - startedAt);
  const localCommand = isLocalCommand(activity.name);
  activity.result = localCommand ? commandMetadata(result) : compactToolActivityResult(context, result, activity.name);
  const visibleTool = localCommand ? { ...activity, result: visibleCommandOutput(result) } : { ...activity };
  context.emit({ type: 'tool_result', tool: visibleTool, round: context.round });
  if (localCommand) activity.arguments = { timeout_ms: activity.arguments?.timeout_ms };
}

function publishDownloadArtifact(context, activity, args, result) {
  if (!context.localInteraction || !context.artifacts || context.artifacts.length >= 16) return;
  const artifact = createDownloadArtifact({ toolName: activity.name, action: args.action, result, toolCallId: activity.id });
  if (!artifact) return;
  try { verifyWorkspaceArtifactSync(context.workspaceDir, artifact); }
  catch (_) { return; }
  context.artifacts.push(artifact);
  context.emit({ type: 'artifacts', artifacts: [...context.artifacts] });
}

async function executeSingleTool(context, call) {
  const toolName = String(call?.function?.name || '').trim();
  const parsedArguments = parseToolArguments(call);
  const args = parsedArguments.args;
  const startedAt = Date.now();
  const activity = {
    id: String(call.id || ''),
    name: toolName,
    arguments: context.compactToolValue(args),
    status: 'running',
  };
  context.toolEvents.push(activity);
  context.traceEvents.push({ type: 'tool', round: context.round, tool: activity });
  context.emit({ type: 'tool_start', tool: { ...activity }, round: context.round });
  let toolResult;
  if (context.blockedAfterBatch) {
    toolResult = routeFailure('BROWSER_PAGE_BATCH_INTERRUPTED', '同轮页面计划已中断，未执行本调用');
  } else if (context.uploadState?.unverified) {
    toolResult = routeFailure('UPLOAD_OUTCOME_UNVERIFIED', '上一次上传结果待核验，未执行此操作');
  } else if (parsedArguments.error) {
    toolResult = normalizeToolFailure({
      message: `MCP 调用格式错误：${parsedArguments.error}`,
      errorCode: 'MCP_ARGUMENTS_INVALID',
      phase: 'tool_parse',
    }, toolName);
  } else try {
    toolResult = await executeChatTool(context, activity, args);
    syncWindowToolControl(context, toolName, args, toolResult);
  } catch (error) {
    if (context.isStopped(error)) return { stopped: true };
    toolResult = normalizeToolFailure(error, toolName);
  }
  const prepared = prepareToolResult(toolResult, toolName);
  publishCompletedActivity(context, activity, toolResult, startedAt, prepared.failed);
  publishDownloadArtifact(context, activity, args, toolResult);
  if (context.signal?.aborted) return { stopped: true };
  const safeResult = isLocalCommand(toolName) ? visibleCommandOutput(prepared.result) : prepared.result;
  const serialized = serializeToolResult(safeResult, toolName, activity.id);
  context.modelMessages.push({
    role: 'tool',
    tool_call_id: activity.id,
    name: toolName,
    content: serialized.content,
  });
  appendPendingImage(context, serialized.imageMessage);
  return { failure: serialized.failure || prepared.failure };
}

async function executeToolCalls(context) {
  let unresolvedToolFailure = '';
  const pendingImageMessages = [];
  const executionContext = { ...context, pendingImageMessages, blockedAfterBatch: false };
  for (const call of context.toolCalls) {
    if (context.signal?.aborted) return { stopped: true, unresolvedToolFailure };
    const result = await executeSingleTool(executionContext, call);
    if (result.stopped) return { stopped: true, unresolvedToolFailure };
    if (executionContext.blockedAfterBatch) continue;
    if (result.failure) unresolvedToolFailure = result.failure;
    if (call?.function?.name === PAGE_BATCH_TOOL.name) {
      executionContext.blockedAfterBatch = Boolean(result.failure || context.hasInsertedMessages?.());
    }
  }
  context.modelMessages.push(...pendingImageMessages);
  return { stopped: false, unresolvedToolFailure };
}

module.exports = {
  browserReference,
  dispatchPluginTool,
  executeSingleTool,
  executeToolCalls,
  normalizeToolFailure,
  parseToolArguments,
  prepareToolResult,
  resolvePluginTarget,
  serializeToolResult,
  syncWindowToolControl,
};

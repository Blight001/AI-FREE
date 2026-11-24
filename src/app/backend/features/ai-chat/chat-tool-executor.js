'use strict';

const { collectConnectionTools } = require('./chat-tool-context');
const { interruptedToolResult } = require('./managed-chat-tool-resume');
const { CHAT_SESSION_TOOL } = require('./managed-chat-contract');
const { guardedBrowserRoute, recordChatTabResult, requiresChatPageGuard, resolvePageGuard, routeFailure } = require('./chat-browser-target');
const { PAGE_BATCH_TOOL } = require('../../services/browser-page-batch');
const { dispatchChatUpload } = require('./chat-browser-upload');
const { recoverChatUpload } = require('./chat-upload-recovery');
const { commandMetadata, executeLocalCommand, isLocalCommand, visibleCommandOutput } = require('./chat-local-command');
const { createChatScreenshotArtifact, createDownloadArtifact, verifyWorkspaceArtifactSync, SCREENSHOT_TOOLS } = require('./ai-workspace-service');
const { writeDebugConsoleOnly } = require('../../runtime/debug-console-log');
const { mcpToolResult } = require('../../services/mcp-tool-result');
const { dispatchAutomationMcpShortcut } = require('../../services/automation-mcp-shortcuts');
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
  const shortcut = await dispatchAutomationMcpShortcut({
    toolName, args, signal: context.signal,
    sanitizeArgs: sanitizeBrowserRoutingArgs,
    getBrowserOverview: context.bridge?.getBrowserOverview
      ? (input) => context.waitForAbort(context.bridge.getBrowserOverview(input)) : null,
    manageCard: context.bridge?.manageCard
      ? (input, signal) => context.waitForAbort(context.bridge.manageCard('', input, { signal })) : null,
  });
  if (shortcut.handled) return shortcut.result;
  return dispatchRoutedPluginTool(context, toolName, args);
}

async function dispatchRoutedPluginTool(context, toolName, args) {
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

function dispatchPageBatch(context, connectionId, args, timeoutMs, guard) {
  return context.bridge.dispatch(connectionId, PAGE_BATCH_TOOL.name, args, {
    timeoutMs, expectedPageToken: guard?.pageToken, signal: context.signal,
    hasInsertedMessages: context.hasInsertedMessages, reportBatchProgress: context.reportBatchProgress,
    waitForAbort: context.waitForAbort,
  });
}

async function dispatchSelectedBrowser(context, connection, toolName, args, timeoutMs) {
  const local = context.localInteraction;
  const guardRequired = requiresChatPageGuard(context, connection.id, toolName, args);
  const target = guardRequired ? await context.waitForAbort(resolvePageGuard(context, connection, toolName, args)) : null;
  if (target && !target.ok) return routeFailure(target.error.code, target.error.message);
  const guard = target?.data;
  const dispatch = (input, name = toolName) => context.bridge.dispatch(connection.id, name, input, {
    timeoutMs, allowAppSurface: !local, signal: context.signal,
    ...(guard ? { expectedPageToken: guard.pageToken } : {}),
  });
  if (toolName === PAGE_BATCH_TOOL.name) return dispatchPageBatch(context, connection.id, args, timeoutMs, guard);
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
    retryable: toolName !== 'manage_card' && error?.retryable === undefined && error?.recoverable === undefined,
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
  const structuredError = toolResult?.error;
  if (toolResult?.ok === false && typeof structuredError?.code === 'string' && typeof structuredError?.message === 'string') {
    return { failed: true, result: toolResult, failure: structuredError.message };
  }
  return prepareLegacyFailure(toolResult, toolName);
}

function prepareLegacyFailure(toolResult, toolName) {
  const failure = String(toolResult?.error || toolResult?.message || `${toolName} 执行失败`);
  const recoverable = toolResult?.recoverable ?? toolResult?.retryable ?? (toolName !== 'manage_card');
  return {
    failed: true,
    failure,
    result: {
      ...(toolResult && typeof toolResult === 'object' ? toolResult : {}),
      success: false,
      error: failure,
      recoverable,
      instruction: !recoverable
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
  for (const tool of ready) {
    if (!known.has(tool.name)) context.toolDefinitions.push(tool);
    else if (tool.name === 'browser_control') {
      const index = context.toolDefinitions.findIndex((existing) => existing.name === tool.name);
      context.toolDefinitions[index] = tool;
    }
  }
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

function persistScreenshotArtifact(context, activity, dataUrl) {
  if (!context.artifacts || context.artifacts.length >= 16) return null;
  try {
    const artifact = createChatScreenshotArtifact({
      workspaceDir: context.workspaceDir, toolName: activity.name, toolCallId: activity.id, dataUrl,
    });
    if (!artifact) return null;
    context.artifacts.push(artifact);
    context.emit({ type: 'artifacts', artifacts: [...context.artifacts] });
    return artifact;
  } catch (error) {
    writeDebugConsoleOnly('warn', '[AIControlScreenshot]', {
      toolName: activity.name, errorCode: error?.code || error?.name || 'SCREENSHOT_SAVE_FAILED',
    });
    return null;
  }
}

function publishToolImage(context, activity, imageMessage, failed) {
  if (!imageMessage) return;
  context.pendingImageMessages?.push(imageMessage);
  if (failed || !context.localInteraction || !SCREENSHOT_TOOLS.has(activity.name)) return;
  const dataUrl = imageMessage.content[1]?.image_url?.url;
  if (!dataUrl || dataUrl.length > 16 * 1024 * 1024 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) return;
  const artifact = persistScreenshotArtifact(context, activity, dataUrl);
  context.emit({ type: 'screenshot', toolCallId: activity.id, dataUrl, ...(artifact ? { artifact } : {}) });
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
  const options = { signal: context.signal };
  const browserScope = activity.name === CHAT_SESSION_TOOL && context.localInteraction
    ? { connections: context.connections } : undefined;
  return context.waitForAbort(context.windowTools.execute(activity.name, args, { ...options, browserScope }));
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
    if (context.isStopped(error)) {
      const interrupted = interruptedToolResult(true);
      publishCompletedActivity(context, activity, interrupted, startedAt, true);
      return { stopped: true };
    }
    toolResult = normalizeToolFailure(error, toolName);
  }
  const prepared = prepareToolResult(toolResult, toolName);
  publishCompletedActivity(context, activity, toolResult, startedAt, prepared.failed);
  publishDownloadArtifact(context, activity, args, toolResult);
  const safeResult = isLocalCommand(toolName) ? visibleCommandOutput(prepared.result) : prepared.result;
  const serialized = serializeToolResult(safeResult, toolName, activity.id);
  context.modelMessages.push({
    role: 'tool',
    tool_call_id: activity.id,
    name: toolName,
    content: serialized.content,
  });
  publishToolImage(context, activity, serialized.imageMessage, prepared.failed);
  return { failure: serialized.failure || prepared.failure };
}

function finishInterruptedTools(context, pendingCalls, pendingImageMessages, interruptedCall) {
  if (context.saveToolProgress) return;
  for (const call of pendingCalls) {
    const result = interruptedToolResult(call === interruptedCall);
    context.modelMessages.push({ role: 'tool', tool_call_id: call.id,
      name: call.function?.name, content: JSON.stringify(result) });
  }
  context.modelMessages.push(...pendingImageMessages);
}

function batchNeedsReplan(context, call, result) {
  return call.function?.name === PAGE_BATCH_TOOL.name && Boolean(result.failure || context.hasInsertedMessages?.());
}

async function executeToolCalls(context) {
  let unresolvedToolFailure = '';
  const pendingImageMessages = [];
  const executionContext = { ...context, pendingImageMessages, blockedAfterBatch: false };
  for (const [index, call] of context.toolCalls.entries()) {
    if (context.signal?.aborted) {
      finishInterruptedTools(context, context.toolCalls.slice(index), pendingImageMessages);
      return { stopped: true, unresolvedToolFailure };
    }
    context.markManagedDispatch?.(call, context.toolCalls.slice(index));
    const result = await executeSingleTool(executionContext, call);
    if (result.stopped) {
      finishInterruptedTools(context, context.toolCalls.slice(index), pendingImageMessages, call);
      return { stopped: true, unresolvedToolFailure };
    }
    context.saveToolProgress?.(context.toolCalls.slice(index + 1));
    if (executionContext.blockedAfterBatch) continue;
    if (result.failure) unresolvedToolFailure = result.failure;
    executionContext.blockedAfterBatch = batchNeedsReplan(context, call, result);
  }
  context.modelMessages.push(...pendingImageMessages);
  return { stopped: Boolean(context.signal?.aborted), unresolvedToolFailure };
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

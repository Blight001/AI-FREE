'use strict';

const { performance } = require('node:perf_hooks');
const { sendCustomAIControlMessage } = require('../../services/custom-ai-api');
const { limitAiControlMessages } = require('../../lib/ai-control-message-window');
const { fitAiControlContext } = require('../../lib/ai-control-context-budget');
const { omitToolImage } = require('../../lib/ai-control-tool-result-budget');
const { writeDebugConsoleOnly } = require('../../runtime/debug-console-log');

const MAX_AI_CONTROL_TOOL_CALLS_PER_ROUND = 40;
const {
  buildStoppedResult,
  compactToolValue,
  finishAfterToolFailure,
  isChatStopped,
  persistedMessages,
  takeInsertedMessages,
  waitForChatAbort,
} = require('./chat-execution-state');
const { executeToolCalls } = require('./chat-tool-executor');
const { parseTextMcpCalls } = require('./chat-text-mcp-parser');
const { normalizeToolCallMessage } = require('../../lib/ai-tool-call-normalizer');

const STREAMED_TOOL_PREFIXES = [
  '<mcp-call', '<mcp_call', '<invoke', '<tool_call', '<xai:function_call',
  '```json', '```tool_call', '```tool-call', '```function_call', '```mcp',
];
const IMAGE_INPUT_UNSUPPORTED_PATTERN = /不支持图片输入|未启用图片输入|不支持视觉|不支持图像输入/i;

function createConversationState(request) {
  return {
    ...request,
    modelMessages: request.toolContext.modelMessages,
    runId: '',
    latestQuota: null,
    reasoningLog: '',
    streamedRoundContent: '',
    streamedRoundRawContent: '',
    streamedRoundContentMode: 'pending',
    streamedRoundReasoning: '',
    toolEvents: [],
    traceEvents: [],
    unresolvedToolFailure: '',
    textToolContinuationPending: false,
    textToolSessionRecoveryAttempted: false,
    imageInputFallbackAttempted: false,
    sentToolImages: false,
    browserControl: { connectionId: String(request.controlledConnectionId || '') },
    browserTargets: new Map(),
    uploadState: { unverified: false, recoveryMessage: '' },
    artifacts: [],
  };
}

function drainInserted(state, notify = true) {
  return takeInsertedMessages(state.run, state.modelMessages, state.emit, notify);
}

function stoppedResult(state) {
  return buildStoppedResult({ ...state, activeRun: state.run });
}

function toolFailureResult(state, failure) {
  return finishAfterToolFailure({ ...state, activeRun: state.run }, failure);
}

function classifyStreamedContent(content) {
  const value = String(content || '').trimStart().toLowerCase();
  if (!value || STREAMED_TOOL_PREFIXES.some((prefix) => prefix.startsWith(value))) return 'pending';
  if (STREAMED_TOOL_PREFIXES.some((prefix) => value.startsWith(prefix))) return 'suppressed';
  return 'visible';
}

function receiveContentDelta(state, event) {
  const delta = String(event?.delta || '');
  state.streamedRoundRawContent += delta;
  if (state.streamedRoundContentMode === 'pending') {
    state.streamedRoundContentMode = classifyStreamedContent(state.streamedRoundRawContent);
  }
  if (state.streamedRoundContentMode !== 'visible') return null;
  const visibleDelta = state.streamedRoundContent
    ? delta
    : state.streamedRoundRawContent;
  state.streamedRoundContent += visibleDelta;
  return { ...event, delta: visibleDelta };
}

function resetStreamedRound(state) {
  state.streamedRoundContent = '';
  state.streamedRoundRawContent = '';
  state.streamedRoundContentMode = 'pending';
  state.streamedRoundReasoning = '';
}

function receiveStreamEvent(state, round, event, forward = true) {
  let visibleEvent = event;
  if (event?.type === 'content_delta') visibleEvent = receiveContentDelta(state, event);
  if (event?.type === 'reasoning_delta') state.streamedRoundReasoning += String(event.delta || '');
  if (forward && visibleEvent && !['result', 'error'].includes(visibleEvent?.type)) {
    state.emit({ ...visibleEvent, round });
  }
}

function sendModelRound(state, round, messages, transport) {
  const tools = state.toolContext.tools;
  const signal = state.run?.controller.signal;
  if (transport === 'custom-api') {
    return sendCustomAIControlMessage(state.customApi, messages, {
      tools,
      signal,
      onEvent: state.useStream && state.streamOutput
        ? (event) => receiveStreamEvent(state, round, event) : undefined,
    });
  }
  if (transport === 'builtin-stream') {
    return state.httpClient.streamAIControlMessage(
      state.key,
      state.deviceId,
      state.modelId,
      messages,
      { tools, runId: state.runId, signal },
      (event) => receiveStreamEvent(state, round, event, state.streamOutput),
    );
  }
  return state.httpClient.sendAIControlMessage(
    state.key,
    state.deviceId,
    state.modelId,
    messages,
    { tools, runId: state.runId },
  );
}

async function requestModelRound(state, round) {
  const contextStart = performance.now();
  const messages = fitAiControlContext(
    state.modelMessages, state.toolContext.tools, { contextWindow: state.customApi?.contextWindow },
  );
  state.sentToolImages = messages.some((message) => message.ai_free_transient_image === true);
  const transport = state.useCustomApi ? 'custom-api'
    : (state.useStream && typeof state.httpClient.streamAIControlMessage === 'function' ? 'builtin-stream' : 'builtin-json');
  const requestStart = performance.now();
  try {
    return await sendModelRound(state, round, messages, transport);
  } finally {
    writeDebugConsoleOnly('info', '[AIControlTiming]', { round, transport,
      contextMs: Math.round(requestStart - contextStart), modelRequestMs: Math.round(performance.now() - requestStart) });
  }
}

function isIdentityFailure(result) {
  const status = Number(result?.status || 0);
  const message = String(result?.message || result?.error || '').trim();
  return [401, 403].includes(status)
    && /登录状态.*(?:无效|失效|过期)|当前设备不匹配|设备未绑定|请先登录|未登录|登录凭据/.test(message);
}

async function recoverAndRetryModelRound(state, round, result) {
  if (!isIdentityFailure(result) || state.identityRecoveryAttempted) return result;
  if (typeof state.recoverIdentity !== 'function') return result;
  state.identityRecoveryAttempted = true;
  let credentials;
  try {
    credentials = await state.recoverIdentity();
  } catch (_) {
    return result;
  }
  if (!credentials?.key || !credentials?.deviceId) return result;
  state.key = credentials.key;
  state.deviceId = credentials.deviceId;
  return requestModelRound(state, round);
}

async function retryExpiredTextToolSession(state, round, result) {
  const message = String(result?.message || result?.error || '');
  const expired = result?.ok === false && /AI 工具调用会话已失效/.test(message);
  if (!expired || !state.textToolContinuationPending || state.textToolSessionRecoveryAttempted) {
    return result;
  }
  state.textToolSessionRecoveryAttempted = true;
  state.runId = '';
  return requestModelRound(state, round);
}

function isImageInputUnsupported(result) {
  const code = String(result?.errorCode || result?.error_code || '').trim();
  const message = String(result?.message || result?.error || '').trim();
  return result?.ok === false
    && (code === 'MODEL_IMAGE_INPUT_UNSUPPORTED' || IMAGE_INPUT_UNSUPPORTED_PATTERN.test(message));
}

async function retryWithoutUnsupportedImages(state, round, result) {
  if (state.imageInputFallbackAttempted || !isImageInputUnsupported(result)) return result;
  if (!state.sentToolImages) return result;
  state.imageInputFallbackAttempted = true;
  const failure = String(result?.message || result?.error || '当前模型不支持图片输入');
  state.modelMessages = state.modelMessages
    .filter((message) => message?.ai_free_transient_image !== true)
    .map((message) => message.role === 'tool' ? omitToolImage(message, 'model_unsupported', failure) : message);
  return requestModelRound(state, round);
}

function applyResultMetadata(state, result, round) {
  state.unresolvedToolFailure = '';
  state.latestQuota = result.quota || state.latestQuota;
  state.runId = String(result.run_id || state.runId || '');
  const reasoning = String(result.message?.reasoning || '');
  if (!reasoning) return;
  state.reasoningLog += `${state.reasoningLog ? '\n\n' : ''}${reasoning}`;
  state.traceEvents.push({ type: 'reasoning', round, content: reasoning });
}

function finishWithoutTools(state, result) {
  state.modelMessages.push({ role: 'assistant', content: String(result.message?.content || '') });
  if (drainInserted(state)) return null;
  const messages = persistedMessages(state.modelMessages);
  const finalResult = {
    ...result,
    quota: state.latestQuota,
    messages,
    message: {
      ...(result.message || {}),
      reasoning: state.reasoningLog,
      tool_events: state.toolEvents,
      trace_events: state.traceEvents,
      artifacts: state.artifacts,
    },
    browserConnectionId: String(state.browserControl?.connectionId || ''),
  };
  state.emit({ type: 'done', message: finalResult.message, quota: finalResult.quota });
  return finalResult;
}

function validateToolRound(state, toolCalls) {
  const knownTools = new Set(
    (state.toolContext.tools || []).map((tool) => String(tool?.name || '').trim()).filter(Boolean),
  );
  const unknownTool = toolCalls.find(
    (call) => !knownTools.has(String(call?.function?.name || '').trim()),
  );
  if (unknownTool) {
    const name = String(unknownTool?.function?.name || '').trim() || '未提供工具名';
    return toolFailureResult(state, `暂无该 MCP 调用：${name}`);
  }
  const needsPlugin = toolCalls.some(
    (call) => !state.windowTools?.has(String(call?.function?.name || '').trim()),
  );
  if (needsPlugin && (!state.connections.length || !state.bridge?.dispatch)) {
    return toolFailureResult(state, '模型请求了浏览器工具，但当前没有选择可用的 Chromium 原生控制连接');
  }
  if (toolCalls.length >= MAX_AI_CONTROL_TOOL_CALLS_PER_ROUND) {
    return toolFailureResult(state, `模型单轮请求了 ${toolCalls.length} 个浏览器工具，超过可安全处理的数量`);
  }
  return null;
}

async function executeToolRound(state, result, toolCalls, round) {
  state.modelMessages.push({
    role: 'assistant',
    content: String(result.message?.content || ''),
    tool_calls: toolCalls,
  });
  resetStreamedRound(state);
  const content = String(result.message?.content || '').trim();
  if (content) state.traceEvents.push({ type: 'step', round, content });
  const execution = await executeToolCalls({
    artifacts: state.artifacts,
    artifactReferences: state.artifactReferences,
    browserTargets: state.browserTargets,
    bridge: state.bridge,
    browserControl: state.browserControl,
    compactToolValue,
    connections: state.connections,
    describeConnections: state.toolContext.describeConnections,
    emit: state.emit,
    hasInsertedMessages: () => Boolean(state.run?.insertedMessages.length),
    isStopped: (error) => isChatStopped(state.run, error),
    localInteraction: state.localInteraction,
    modelMessages: state.modelMessages,
    round,
    toolCalls,
    toolEvents: state.toolEvents,
    toolDefinitions: state.toolContext.tools,
    traceEvents: state.traceEvents,
    uploadState: state.uploadState,
    signal: state.run?.controller.signal,
    waitForAbort: (promise) => waitForChatAbort(state.run, promise),
    windowTools: state.windowTools,
    workspaceDir: state.workspaceDir,
  });
  if (execution.unresolvedToolFailure) state.unresolvedToolFailure = execution.unresolvedToolFailure;
  return execution;
}

async function requestRoundSafely(state, round) {
  try {
    const initialResult = await requestModelRound(state, round);
    const retriedResult = await retryExpiredTextToolSession(state, round, initialResult);
    const identityResult = await recoverAndRetryModelRound(state, round, retriedResult);
    const result = await retryWithoutUnsupportedImages(state, round, identityResult);
    if (result?.ok) state.textToolContinuationPending = false;
    if (isChatStopped(state.run)) return { done: true, result: stoppedResult(state) };
    return { done: false, result };
  } catch (error) {
    if (isChatStopped(state.run, error)) return { done: true, result: stoppedResult(state) };
    if (state.unresolvedToolFailure) {
      return { done: true, result: toolFailureResult(state, error?.message || state.unresolvedToolFailure) };
    }
    throw error;
  }
}

function handleFailedModelResult(state, result) {
  if (result?.ok) return null;
  if (state.unresolvedToolFailure) {
    return { result: toolFailureResult(state, result?.message || result?.error) };
  }
  state.emit({ type: 'error', message: result?.message || result?.error || '对话请求失败' });
  return { result };
}

async function runChatRound(state, round) {
  if (isChatStopped(state.run)) return { done: true, result: stoppedResult(state) };
  drainInserted(state);
  resetStreamedRound(state);
  state.emit({ type: 'round_start', round });
  state.modelMessages = limitAiControlMessages(state.modelMessages);
  const requested = await requestRoundSafely(state, round);
  const modelReady = performance.now();
  if (requested.done) return requested;
  const failed = handleFailedModelResult(state, requested.result);
  if (failed) return { done: true, result: failed.result };
  applyResultMetadata(state, requested.result, round);
  const normalizedMessage = normalizeToolCallMessage(requested.result.message);
  requested.result.message.content = normalizedMessage.content;
  let toolCalls = normalizedMessage.toolCalls;
  let parsedFromText = false;
  if (!toolCalls.length) {
    const parsed = parseTextMcpCalls(requested.result.message?.content, round);
    if (parsed.detected) {
      requested.result.message.content = parsed.content;
      toolCalls = parsed.toolCalls;
      parsedFromText = toolCalls.length > 0;
      state.emit({ type: 'content_replace', content: parsed.content, round });
      if (parsed.error) {
        return { done: true, result: finishWithoutTools(state, requested.result) };
      }
    }
  }
  if (!toolCalls.length) {
    const finalResult = finishWithoutTools(state, requested.result);
    return finalResult ? { done: true, result: finalResult } : { done: false };
  }
  const invalid = validateToolRound(state, toolCalls);
  if (invalid) return { done: true, result: invalid };
  if (parsedFromText) {
    state.textToolContinuationPending = true;
    state.textToolSessionRecoveryAttempted = false;
  }
  const toolsStart = performance.now();
  const execution = await executeToolRound(state, requested.result, toolCalls, round);
  writeDebugConsoleOnly('info', '[AIControlTiming]', { round, toolCount: toolCalls.length,
    dispatchPrepMs: Math.round(toolsStart - modelReady), toolBatchMs: Math.round(performance.now() - toolsStart) });
  if (state.uploadState.unverified) {
    return { done: true, result: toolFailureResult(state, state.uploadState.recoveryMessage) };
  }
  if (execution.stopped) return { done: true, result: stoppedResult(state) };
  drainInserted(state);
  return { done: false };
}

async function runChatConversation(request) {
  const state = createConversationState(request);
  for (let round = 0; ; round += 1) {
    const outcome = await runChatRound(state, round);
    if (outcome.done) return outcome.result;
  }
}

module.exports = {
  applyResultMetadata,
  classifyStreamedContent,
  createConversationState,
  executeToolRound,
  finishWithoutTools,
  requestModelRound,
  recoverAndRetryModelRound,
  retryWithoutUnsupportedImages,
  retryExpiredTextToolSession,
  requestRoundSafely,
  runChatRound,
  runChatConversation,
  validateToolRound,
};

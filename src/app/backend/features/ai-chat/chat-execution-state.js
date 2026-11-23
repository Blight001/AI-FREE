'use strict';

const { limitAiControlMessages } = require('../../lib/ai-control-message-window');
const { isLocalCommand, commandMetadata } = require('./chat-local-command');

function compactToolValue(value) {
  return value;
}

function isChatStopped(activeRun, error) {
  return activeRun?.stopped || activeRun?.controller.signal.aborted
    || error?.name === 'AbortError' || error?.code === 'ERR_CANCELED';
}

function waitForChatAbort(activeRun, promise) {
  if (!activeRun) return promise;
  return new Promise((resolve, reject) => {
    const signal = activeRun.controller.signal;
    const onAbort = () => {
      const error = new Error('AI 输出已停止');
      error.name = 'AbortError';
      reject(error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
    if (signal.aborted) {
      signal.removeEventListener('abort', onAbort);
      onAbort();
    }
  });
}

function takeInsertedMessages(activeRun, modelMessages, emit, notify = true) {
  if (!activeRun?.insertedMessages.length) return false;
  const inserted = activeRun.insertedMessages.splice(0);
  modelMessages.push(...inserted);
  if (notify) emit({ type: 'user_inserted', count: inserted.length });
  return true;
}

function sessionMessage(message) {
  return message?.ai_free_card_context !== true && message?.ai_free_transient_image !== true
    && message?.ai_free_attachment_context !== true;
}

function persistedMessages(messages) {
  return limitAiControlMessages(messages.filter(sessionMessage).map((message) => {
    if (message.role !== 'tool' || !isLocalCommand(message.name)) return message;
    let result;
    try { result = JSON.parse(message.content); } catch (_) { result = {}; }
    return { ...message, content: JSON.stringify(commandMetadata(result)) };
  }));
}

function buildStoppedResult(context) {
  takeInsertedMessages(context.activeRun, context.modelMessages, context.emit, false);
  const partialReasoning = String(context.streamedRoundReasoning || '');
  const partialContent = String(context.streamedRoundContent || '');
  const stoppedTraceEvents = partialReasoning
    ? [...context.traceEvents, { type: 'reasoning', round: context.traceEvents.length, content: partialReasoning }]
    : [...context.traceEvents];
  const cleanMessages = persistedMessages(context.modelMessages);
  const stoppedMessage = {
    role: 'assistant',
    content: partialContent,
    reasoning: `${context.reasoningLog}${context.reasoningLog && partialReasoning ? '\n\n' : ''}${partialReasoning}`,
    tool_events: context.toolEvents,
    trace_events: stoppedTraceEvents,
    artifacts: context.artifacts || [],
    stopped: true,
  };
  if (partialContent.trim() || stoppedMessage.reasoning.trim() || context.toolEvents.length) {
    cleanMessages.push({ role: 'assistant', content: partialContent });
  }
  const result = {
    ok: true,
    stopped: true,
    quota: context.latestQuota,
    messages: cleanMessages,
    message: stoppedMessage,
  };
  context.emit({ type: 'stopped', message: stoppedMessage, quota: context.latestQuota });
  return result;
}

function finishAfterToolFailure(context, failureMessage) {
  const detail = String(failureMessage || context.unresolvedToolFailure || 'Chromium 原生控制执行失败').trim().slice(0, 1000);
  const content = context.uploadState?.unverified ? detail
    : `浏览器原生操作失败：${detail}\n\n当前对话已保留，你可以检查浏览器连接或调整操作后重试。`;
  const finalMessages = persistedMessages([
    ...context.modelMessages,
    { role: 'assistant', content },
  ]);
  const result = {
    ok: true,
    recoveredFromToolError: true,
    quota: context.latestQuota,
    messages: finalMessages,
    message: {
      role: 'assistant', content, reasoning: context.reasoningLog,
      tool_events: context.toolEvents, trace_events: context.traceEvents,
      artifacts: context.artifacts || [],
    },
  };
  context.emit({ type: 'done', message: result.message, quota: result.quota });
  return result;
}

module.exports = {
  buildStoppedResult,
  compactToolValue,
  finishAfterToolFailure,
  isChatStopped,
  persistedMessages,
  takeInsertedMessages,
  waitForChatAbort,
};

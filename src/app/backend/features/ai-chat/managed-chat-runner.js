'use strict';

const { createHash } = require('node:crypto');
const { resolveChatAccess, normalizeChatOptions } = require('./chat-request-context');
const { runChatConversation } = require('./chat-conversation-runner');

const previousResultTool = {
  name: 'chat_previous_result',
  description: '读取当前子会话中此前已完成的回复。可用于核对旧结论，或读取由于上下文限制被省略的记录。',
  input_schema: { type: 'object', properties: { index: { type: 'integer', minimum: 1 } }, required: ['index'], additionalProperties: false },
};

function previousResults(session, record) {
  const history = session.runs.slice(0, session.runs.findIndex((item) => item.id === record.id));
  return history.filter((item) => item.status === 'completed');
}

function historyMessages(history, record) {
  return [...history.flatMap((item) => [
    { role: 'user', content: item.content },
    ...item.inserts.map(({ content }) => ({ role: 'user', content })),
    { role: 'assistant', content: item.result },
  ]), { role: 'user', content: record.content }];
}

function createManagedChatRunner(deps) {
  return async ({ session, record, signal, inserted, checkpoint, saveCheckpoint, emit }) => {
    const access = resolveChatAccess(deps, { modelId: record.modelId });
    if (access.error) return access.error;
    const provider = createHash('sha256').update(JSON.stringify([
      record.modelId, access.customApi?.baseUrl, access.customApi?.model,
    ])).digest('hex');
    if (checkpoint?.provider && checkpoint.provider !== provider) {
      return { ok: false, stopped: true, message: { content: '模型配置已变更，恢复原配置后可继续。' } };
    }
    const history = previousResults(session, record);
    const windowTools = {
      has: (name) => name === previousResultTool.name,
      execute: (_name, { index }) => {
        const item = Number.isInteger(index) && index > 0 ? history.at(-index) : undefined;
        return item ? { success: true, content: item.result } : { success: false, error: '没有对应的已完成回复' };
      },
    };
    const modelMessages = checkpoint?.messages || historyMessages(history, record);
    const toolContext = {
      modelMessages,
      tools: access.customApi?.supportsTools === false ? [] : [previousResultTool],
    };
    const options = normalizeChatOptions({ requestId: record.id, stream: true });
    const request = {
      ...access, ...options, connections: [], controlledConnectionId: '', windowTools, toolContext, emit,
      run: { controller: { signal }, insertedMessages: inserted, stoppedByUser: false },
      managedCheckpoint: checkpoint, saveManagedCheckpoint: (progress) => saveCheckpoint({ ...progress, provider }),
    };
    return runChatConversation(request);
  };
}

module.exports = { createManagedChatRunner };

// IPC 请求 payload 运行时校验（阶段 2）。
// schema 只描述进程边界允许接收的形状；业务必填、权限和状态规则仍由 domain/service 判断。
// 校验错误不记录实际字段值，避免 API Key、Cookie、礼品码等敏感内容进入日志。
'use strict';

const { AppError, fail: ipcFailure } = require('./ipc-result');
const { getRequestSchema, hasResultEnvelope } = require('./ipc-channels');

const MAX_ID_LENGTH = 512;
const MAX_TEXT_LENGTH = 2 * 1024 * 1024;
const MAX_LIST_LENGTH = 128;
const AUTOMATION_CARD_ACTIONS = new Set([
  'rules', 'list', 'get', 'write', 'patch_step', 'insert_step',
  'delete_step', 'move_step', 'delete', 'run', 'validate', 'clone',
  'versions', 'get_version', 'set_enabled', 'export', 'start_run',
  'list_runs', 'get_run', 'list_run_steps', 'cancel_run', 'retry_run',
  'pause_run', 'resume_run', 'step_run', 'restore', 'purge',
]);

class IpcPayloadError extends AppError {
  constructor(channel, path, reason) {
    const field = path || 'payload';
    super('IPC_INVALID_PAYLOAD', `请求参数无效：${field} ${reason}`, {
      retryable: false,
      details: { channel, path: field, reason },
    });
    this.name = 'IpcPayloadError';
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(channel, path, reason) {
  throw new IpcPayloadError(channel, path, reason);
}

function objectPayload(channel, payload, { optional = false } = {}) {
  if (payload === undefined && optional) return {};
  if (!isPlainObject(payload)) fail(channel, 'payload', '必须是对象');
  return payload;
}

function stringField(channel, object, key, options = {}) {
  const { required = false, maxLength = MAX_ID_LENGTH, path = key } = options;
  const value = object[key];
  if (value === undefined && !required) return;
  if (typeof value !== 'string') fail(channel, path, '必须是字符串');
  if (value.length > maxLength) fail(channel, path, `长度不能超过 ${maxLength}`);
}

function booleanField(channel, object, key) {
  if (object[key] !== undefined && typeof object[key] !== 'boolean') {
    fail(channel, key, '必须是布尔值');
  }
}

function stringListField(channel, object, key) {
  const list = object[key];
  if (list === undefined) return;
  if (!Array.isArray(list)) fail(channel, key, '必须是数组');
  if (list.length > MAX_LIST_LENGTH) fail(channel, key, `数量不能超过 ${MAX_LIST_LENGTH}`);
  if (list.some((item) => typeof item !== 'string' || item.length > MAX_ID_LENGTH)) {
    fail(channel, `${key}[]`, `必须是长度不超过 ${MAX_ID_LENGTH} 的字符串`);
  }
}

function numberLikeField(channel, object, key) {
  const value = object[key];
  if (value === undefined) return;
  if ((typeof value !== 'number' && typeof value !== 'string') || !Number.isFinite(Number(value))) {
    fail(channel, key, '必须是有效数字');
  }
}

function validateChatMessage(channel, message, index) {
  const path = `messages[${index}]`;
  if (!isPlainObject(message)) fail(channel, path, '必须是对象');
  stringField(channel, message, 'role', { maxLength: 32, path: `${path}.role` });
  if (message.content !== undefined && typeof message.content !== 'string' && !Array.isArray(message.content)) {
    fail(channel, `${path}.content`, '必须是字符串或数组');
  }
  for (const key of ['tool_call_id', 'name', 'reasoning']) {
    stringField(channel, message, key, {
      maxLength: key === 'reasoning' ? MAX_TEXT_LENGTH : MAX_ID_LENGTH,
      path: `${path}.${key}`,
    });
  }
  if (message.inlineAttachments !== undefined) {
    if (!Array.isArray(message.inlineAttachments) || message.inlineAttachments.length > 16) fail(channel, `${path}.inlineAttachments`, '必须是最多 16 项的数组');
    message.inlineAttachments.forEach((item, itemIndex) => {
      const itemPath = `${path}.inlineAttachments[${itemIndex}]`;
      if (!isPlainObject(item)) fail(channel, itemPath, '必须是对象');
      stringField(channel, item, 'path', { required: true, maxLength: 4096, path: `${itemPath}.path` });
      stringField(channel, item, 'marker', { required: true, maxLength: 512, path: `${itemPath}.marker` });
    });
  }
  for (const key of ['tool_calls', 'tool_events', 'trace_events']) {
    if (message[key] === undefined) continue;
    if (!Array.isArray(message[key])) fail(channel, `${path}.${key}`, '必须是数组');
  }
}

function validateChatMentions(channel, mentions) {
  if (mentions === undefined) return;
  if (!Array.isArray(mentions) || mentions.length > 32) fail(channel, 'mentions', '必须是最多 32 项的数组');
  mentions.forEach((mention, index) => {
    if (!isPlainObject(mention)) fail(channel, `mentions[${index}]`, '必须是对象');
    for (const key of ['type', 'label', 'reference', 'detail']) {
      stringField(channel, mention, key, { maxLength: 4096, path: `mentions[${index}].${key}` });
    }
  });
}

function validateArtifactPayload(channel, item, key = 'artifact') {
  if (!isPlainObject(item)) fail(channel, key, '必须是文件产物对象');
  stringField(channel, item, 'path', { required: true, maxLength: 4096, path: `${key}.path` });
  stringField(channel, item, 'sha256', { required: true, maxLength: 64, path: `${key}.sha256` });
  stringField(channel, item, 'toolName', { required: true, maxLength: 32, path: `${key}.toolName` });
  stringField(channel, item, 'toolCallId', { required: true, maxLength: 256, path: `${key}.toolCallId` });
  stringField(channel, item, 'kind', { required: true, maxLength: 32, path: `${key}.kind` });
  if (!Number.isSafeInteger(item.size) || item.size < 0) fail(channel, `${key}.size`, '必须为非负整数');
}

function validateArtifactReferences(channel, references) {
  if (references === undefined) return;
  if (!Array.isArray(references) || references.length > 16) fail(channel, 'artifactReferences', '最多 16 个文件产物');
  references.forEach((item, index) => validateArtifactPayload(channel, item, `artifactReferences[${index}]`));
}

function validateHistorySession(channel, session) {
  if (!isPlainObject(session)) fail(channel, 'session', '必须是对象');
  for (const key of ['id', 'title', 'modelId', 'browserConnectionId', 'automationCardId', 'preview']) {
    stringField(channel, session, key, { maxLength: key === 'preview' ? MAX_TEXT_LENGTH : MAX_ID_LENGTH });
  }
  stringListField(channel, session, 'browserConnectionIds');
  if (session.messages !== undefined) {
    if (!Array.isArray(session.messages)) fail(channel, 'session.messages', '必须是数组');
  }
}

function providerPayload(channel, payload) {
  const input = objectPayload(channel, payload);
  stringField(channel, input, 'provider', { required: true, maxLength: 64 });
  return input;
}

function providerRecordPayload(channel, payload) {
  const input = providerPayload(channel, payload);
  stringField(channel, input, 'id', { required: true, maxLength: 64 });
  return input;
}

const IPC_PAYLOAD_SCHEMAS = Object.freeze({
  'account.provider-list': providerPayload,
  'account.provider-save': (channel, payload) => {
    const input = providerPayload(channel, payload);
    stringField(channel, input, 'email', { required: true, maxLength: 254 });
    stringField(channel, input, 'password', { required: true, maxLength: 1024 });
    for (const field of ['note', 'smsUrl']) stringField(channel, input, field, { maxLength: 2048 });
    return input;
  },
  'account.provider-update': (channel, payload) => {
    const input = providerRecordPayload(channel, payload);
    stringField(channel, input, 'email', { required: true, maxLength: 254 });
    stringField(channel, input, 'password', { maxLength: 1024 });
    stringField(channel, input, 'note', { required: true, maxLength: 2048 });
    return input;
  },
  'account.trash-record': (channel, payload) => {
    const input = objectPayload(channel, payload);
    stringField(channel, input, 'id', { required: true, maxLength: 64 });
    return input;
  },
  'account.provider-delete': providerRecordPayload,
  'account.provider-record': providerRecordPayload,
  'account.category-create': (channel, payload) => {
    const input = objectPayload(channel, payload);
    stringField(channel, input, 'name', { required: true, maxLength: 32 });
    return input;
  },
  'account.category-rename': (channel, payload) => {
    const input = providerPayload(channel, payload);
    stringField(channel, input, 'name', { required: true, maxLength: 32 });
    return input;
  },
  'account.provider-note': (channel, payload) => {
    const input = providerRecordPayload(channel, payload);
    stringField(channel, input, 'note', { required: true, maxLength: 2048 });
    return input;
  },
  'account.authenticate': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    stringField(channel, input, 'mode', { maxLength: 32 });
    stringField(channel, input, 'username', { maxLength: 256 });
    stringField(channel, input, 'password', { maxLength: 4096 });
    return input;
  },
  'account.gift-code': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    stringField(channel, input, 'code', { maxLength: 512 });
    return input;
  },
  'ai.browser-selection': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    stringField(channel, input, 'profileId');
    stringListField(channel, input, 'profileIds');
    return input;
  },
  'ai.card-selection': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    stringField(channel, input, 'id');
    return input;
  },
  'ai.chat': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    for (const key of ['modelId', 'requestId', 'browserConnectionId', 'automationCardId']) {
      stringField(channel, input, key);
    }
    stringListField(channel, input, 'browserConnectionIds');
    stringListField(channel, input, 'attachmentPaths');
    validateArtifactReferences(channel, input.artifactReferences);
    validateChatMentions(channel, input.mentions);
    for (const key of ['disableTools', 'stream', 'localInteraction']) booleanField(channel, input, key);
    if (input.quota !== undefined && input.quota !== null && !isPlainObject(input.quota)) {
      fail(channel, 'quota', '必须是对象或 null');
    }
    if (input.messages !== undefined) {
      if (!Array.isArray(input.messages)) fail(channel, 'messages', '必须是数组');
      input.messages.forEach((message, index) => validateChatMessage(channel, message, index));
    }
    return input;
  },
  'ai.chat-insert': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    stringField(channel, input, 'requestId');
    stringField(channel, input, 'content', { maxLength: MAX_TEXT_LENGTH });
    return input;
  },
  'ai.chat-stop': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    stringField(channel, input, 'requestId');
    return input;
  },
  'ai.chat-approval': (channel, payload) => {
    const input = objectPayload(channel, payload);
    stringField(channel, input, 'requestId', { required: true, maxLength: 256 });
    stringField(channel, input, 'id', { required: true, maxLength: 256 });
    if (typeof input.accepted !== 'boolean') fail(channel, 'accepted', '必须是布尔值');
    return input;
  },
  'ai.gift-code': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    stringField(channel, input, 'code');
    return input;
  },
  'ai.custom-api': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    for (const key of ['clear', 'enabled']) booleanField(channel, input, key);
    for (const key of ['supportsImageInput', 'supportsTools', 'supportsReasoning', 'customProtocol']) booleanField(channel, input, key);
    stringField(channel, input, 'name', { maxLength: 80 });
    stringField(channel, input, 'id', { maxLength: 128 });
    stringField(channel, input, 'baseUrl', { maxLength: 2048 });
    stringField(channel, input, 'model', { maxLength: 200 });
    stringField(channel, input, 'apiKey', { maxLength: 4096 });
    numberLikeField(channel, input, 'contextWindow');
    numberLikeField(channel, input, 'maxOutputTokens');
    return input;
  },
  'ai.custom-model-delete': (channel, payload) => {
    const input = objectPayload(channel, payload);
    stringField(channel, input, 'id', { required: true, maxLength: 128 });
    return input;
  },
  'ai.custom-api-batch': (channel, payload) => {
    const input = objectPayload(channel, payload);
    if (!Array.isArray(input.models) || input.models.length < 1 || input.models.length > 64) fail(channel, 'models', '必须是 1 到 64 项的数组');
    input.models.forEach((model, index) => {
      if (!isPlainObject(model)) fail(channel, `models[${index}]`, '必须是对象');
      for (const key of ['id', 'name', 'baseUrl', 'model', 'apiKey']) stringField(channel, model, key, { maxLength: key === 'apiKey' ? 4096 : key === 'baseUrl' ? 2048 : key === 'name' ? 80 : key === 'model' ? 200 : 128 });
      for (const key of ['supportsImageInput', 'supportsTools', 'supportsReasoning', 'customProtocol']) booleanField(channel, model, key);
      numberLikeField(channel, model, 'contextWindow');
      numberLikeField(channel, model, 'maxOutputTokens');
    });
    return input;
  },
  'ai.server-device-login': (channel, payload) => {
    const input = objectPayload(channel, payload);
    stringField(channel, input, 'server', { maxLength: 2048 });
    stringField(channel, input, 'account', { maxLength: 200 });
    stringField(channel, input, 'password', { maxLength: 4096 });
    stringField(channel, input, 'serviceName', { maxLength: 80 });
    return input;
  },
  'ai.history-create': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    for (const key of ['modelId', 'browserConnectionId', 'automationCardId']) stringField(channel, input, key);
    stringListField(channel, input, 'browserConnectionIds');
    return input;
  },
  'browser.transfer-site': (channel, payload) => {
    const input = objectPayload(channel, payload);
    for (const key of ['sourceId', 'targetId', 'host']) stringField(channel, input, key, { required: true });
    stringField(channel, input, 'revision', { maxLength: 64 });
    return input;
  },
  'browser.transfer-indexed-db': (channel, payload) => {
    const input = objectPayload(channel, payload);
    for (const key of ['sourceId', 'targetId']) stringField(channel, input, key, { required: true });
    stringField(channel, input, input.host === undefined ? 'origin' : 'host', { required: true, maxLength: 512 });
    stringField(channel, input, 'revision', { maxLength: 64 });
    const scope = input.host === undefined ? { origin: input.origin } : { host: input.host };
    return { sourceId: input.sourceId, targetId: input.targetId, ...scope, revision: input.revision };
  },
  'browser.site-data': (channel, payload) => {
    const input = objectPayload(channel, payload);
    stringField(channel, input, 'historyId', { required: true });
    return { historyId: input.historyId };
  },
  'ai.history-id': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    stringField(channel, input, 'id');
    return input;
  },
  'ai.history-rename': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    stringField(channel, input, 'id');
    stringField(channel, input, 'title', { maxLength: MAX_TEXT_LENGTH });
    return input;
  },
  'ai.history-save': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    booleanField(channel, input, 'setCurrent');
    validateHistorySession(channel, input.session === undefined ? input : input.session);
    return input;
  },
  'ui.window-close-behavior': (channel, payload) => {
    const input = objectPayload(channel, payload);
    stringField(channel, input, 'behavior', { required: true, maxLength: 8 });
    if (!['ask', 'hide', 'quit'].includes(input.behavior)) {
      fail(channel, 'behavior', '必须是 ask、hide 或 quit');
    }
    return input;
  },
  'ai.workflow': (channel, payload) => {
    const input = objectPayload(channel, payload);
    const allowed = new Set(['connection_id', 'action', 'mode', 'include_details']);
    Object.keys(input).forEach((key) => { if (!allowed.has(key)) fail(channel, key, '不支持的字段'); });
    stringField(channel, input, 'connection_id', { required: true });
    stringField(channel, input, 'action', { required: true, maxLength: 32 });
    if (!['status', 'set_mode', 'pause', 'resume', 'report', 'cancel'].includes(input.action)) fail(channel, 'action', '不支持的动作');
    stringField(channel, input, 'mode', { maxLength: 32 });
    booleanField(channel, input, 'include_details');
    return input;
  },
  'ui.startup-settings': (channel, payload) => {
    const input = objectPayload(channel, payload);
    booleanField(channel, input, 'enabled');
    return input;
  },
  'ai.workspace-read': (channel, payload) => {
    const input = objectPayload(channel, payload);
    stringField(channel, input, 'path', { required: true, maxLength: 4096 });
    booleanField(channel, input, 'validateOnly');
    if (input.artifact !== undefined) validateArtifactPayload(channel, input.artifact);
    return input;
  },
  'ai.workspace-pasted-files': (channel, payload) => {
    const input = objectPayload(channel, payload);
    if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 16) fail(channel, 'files', '必须是 1 到 16 个文件');
    input.files.forEach((file, index) => {
      const filePath = `files[${index}]`;
      if (!isPlainObject(file)) fail(channel, filePath, '必须是对象');
      stringField(channel, file, 'name', { required: true, maxLength: 512, path: `${filePath}.name` });
      stringField(channel, file, 'data', { required: true, maxLength: 14 * 1024 * 1024, path: `${filePath}.data` });
    });
    return input;
  },
  'ui.sidebar-width': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    numberLikeField(channel, input, 'width');
    return input;
  },
  'ui.ui-scale': (channel, payload) => {
    const input = objectPayload(channel, payload);
    numberLikeField(channel, input, 'scale');
    return input;
  },
  'ai.automation-card-operation': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    stringField(channel, input, 'action', { required: true, maxLength: 32 });
    if (!AUTOMATION_CARD_ACTIONS.has(input.action)) fail(channel, 'action', '不是受支持的卡片操作');
    for (const key of [
      'connectionId', 'id', 'card_name', 'version_id', 'run_id', 'reason',
      'idempotency_key', 'status',
    ]) stringField(channel, input, key);
    for (const key of ['cardData', 'stepData', 'stepPatch', 'inputs']) {
      if (input[key] !== undefined && !isPlainObject(input[key]) && !Array.isArray(input[key])) {
        fail(channel, key, '必须是对象或数组');
      }
    }
    for (const key of ['step_index', 'to_step_index', 'start_step']) numberLikeField(channel, input, key);
    for (const key of ['replace', 'enabled', 'include_deleted']) booleanField(channel, input, key);
    return input;
  },
  'ai.automation-session': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    stringField(channel, input, 'connectionId');
    stringField(channel, input, 'format', { maxLength: 16 });
    return input;
  },
});

function hasIpcPayloadSchema(schemaName) {
  return typeof IPC_PAYLOAD_SCHEMAS[schemaName] === 'function';
}

function validateIpcPayload(channel, payload) {
  const schemaName = getRequestSchema(channel);
  if (!schemaName) return payload;
  const schema = IPC_PAYLOAD_SCHEMAS[schemaName];
  if (!schema) throw new Error(`IPC 通道 '${channel}' 引用了未登记 schema '${schemaName}'`);
  return schema(channel, payload);
}

function wrapLegacyIpcPayload(channel, handler) {
  return async (event, payload, ...rest) => {
    try {
      const validated = validateIpcPayload(channel, payload);
      return await handler(event, validated, ...rest);
    } catch (error) {
      if (!(error instanceof IpcPayloadError)) throw error;
      if (hasResultEnvelope(channel)) return ipcFailure(error);
      return { ok: false, code: error.code, message: error.message };
    }
  };
}

function wrapLegacyIpcEventPayload(channel, listener, logger = console) {
  return (event, payload, ...rest) => {
    try {
      const validated = validateIpcPayload(channel, payload);
      return listener(event, validated, ...rest);
    } catch (error) {
      if (!(error instanceof IpcPayloadError)) throw error;
      /** @type {{ path?: string, reason?: string }} */
      const details = error.details && typeof error.details === 'object' ? error.details : {};
      logger.warn?.(`[IPC] ${channel} 请求参数校验失败`, {
        channel,
        errorCode: error.code,
        path: details.path,
        reason: details.reason,
      });
      return undefined;
    }
  };
}

module.exports = {
  IPC_PAYLOAD_SCHEMAS,
  IpcPayloadError,
  hasIpcPayloadSchema,
  validateIpcPayload,
  wrapLegacyIpcPayload,
  wrapLegacyIpcEventPayload,
};

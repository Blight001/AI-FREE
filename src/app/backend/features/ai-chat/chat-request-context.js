'use strict';

const {
  getCustomAiApiConfig,
  getCustomAiApiConfigById,
  isCustomAiApiConfigured,
  isCustomAiModelId,
} = require('../../utils/ai-control-settings');
const { normalizeAccountSession } = require('../../utils/account-session');
const { enrichBrowserConnectionNames } = require('./connection-names');
const { listAutomationCards } = require('./automation-card-service');
const { buildChatToolContext } = require('./chat-tool-context');
const { buildAttachmentMessages, buildInlineAttachmentMessages } = require('./ai-workspace-service');

function validateQuota(quota) {
  if (!quota || quota.unlimited === true) return null;
  const total = Number(quota.quota);
  const used = Number(quota.used || 0);
  const remaining = Number(quota.remaining ?? (total - used));
  return Number.isFinite(remaining) && remaining <= 0
    ? { ok: false, message: 'AI 对话额度已用尽，请联系管理员', quota }
    : null;
}

function resolveCustomAccess(store, modelId) {
  const customApi = getCustomAiApiConfigById(store, modelId)
    || (modelId === '__custom_openai_api__' ? getCustomAiApiConfig(store) : null);
  if (!isCustomAiApiConfigured(customApi)) {
    const message = modelId === '__custom_openai_api__'
      ? '自定义 API 尚未配置完整，请重新配置'
      : '所选自定义模型不存在或配置不完整，请重新选择';
    return { error: { ok: false, message } };
  }
  return { customApi, deviceId: '', httpClient: null, key: '', modelId, useCustomApi: true };
}

function resolveBuiltinAccess(deps, store, input, modelId) {
  const credentials = normalizeAccountSession(store?.userCredentials || {});
  const key = String(credentials.key || '').trim();
  const deviceId = String(credentials.deviceId || '').trim();
  if (!key || !deviceId) return { error: { ok: false, message: '请先在个人中心登录账号' } };
  const httpClient = deps.getGlobalHttpClient?.();
  if (typeof httpClient?.sendAIControlMessage !== 'function') {
    return { error: { ok: false, message: 'AI 服务尚未就绪' } };
  }
  const quota = input.quota && typeof input.quota === 'object' ? input.quota : null;
  const quotaError = validateQuota(quota);
  if (quotaError) return { error: quotaError };
  return {
    customApi: null,
    deviceId,
    httpClient,
    key,
    modelId,
    recoverIdentity: createIdentityRecovery(deps),
    useCustomApi: false,
  };
}

function createIdentityRecovery(deps) {
  if (typeof deps.accountService?.authenticate !== 'function') return null;
  return async () => {
    const refreshed = await deps.accountService.authenticate({ mode: 'device' });
    if (refreshed?.ok !== true) return null;
    const credentials = normalizeAccountSession(deps.readStoreConfigSafe()?.userCredentials || {});
    const key = String(credentials.key || '').trim();
    const deviceId = String(credentials.deviceId || '').trim();
    return key && deviceId ? { key, deviceId } : null;
  };
}

function resolveChatAccess(deps, input) {
  const modelId = String(input.modelId || '').trim();
  if (isCustomAiModelId(modelId)) {
    const modelStore = deps.aiModelConfig ? deps.aiModelConfig.readStore() : deps.readStoreConfigSafe();
    return resolveCustomAccess(modelStore, modelId);
  }
  return resolveBuiltinAccess(deps, deps.readStoreConfigSafe(), input, modelId);
}

function normalizeChatOptions(input) {
  const rawIds = Array.isArray(input.browserConnectionIds)
    ? input.browserConnectionIds
    : (input.browserConnectionId ? [input.browserConnectionId] : []);
  return {
    automationCardId: String(input.automationCardId || '').trim(),
    attachmentPaths: [...new Set((Array.isArray(input.attachmentPaths) ? input.attachmentPaths : [])
      .map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 16),
    connectionIds: [...new Set(rawIds.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 1),
    disableTools: input.disableTools === true,
    artifactReferences: input.artifactReferences || [],
    initialMessages: Array.isArray(input.messages) ? input.messages : [],
    localInteraction: input.localInteraction === true,
    mentions: Array.isArray(input.mentions) ? input.mentions : [],
    requestId: String(input.requestId || '').trim(),
    streamOutput: input.streamOutput !== false,
    useStream: input.stream === true,
  };
}

function resolveConnections(deps, options) {
  if (options.disableTools) return { connections: [] };
  const publicConnections = deps.browserAutomationBridge?.listConnections?.() || [];
  const connections = publicConnections
    .map((item) => deps.browserAutomationBridge?.getConnection?.(item.id))
    .filter(Boolean);
  const availableIds = new Set(connections.map((item) => String(item?.id || '')).filter(Boolean));
  const preferred = (options.connectionIds || []).find((id) => availableIds.has(id));
  if (options.localInteraction && options.connectionIds?.length && !preferred) {
    return { error: { ok: false, errorCode: 'BROWSER_ROUTE_NOT_FOUND', message: '所选浏览器已离线，请重新选择' } };
  }
  const controlledConnectionId = preferred || (options.localInteraction && connections.length > 1 ? '' : String(connections[0]?.id || ''));
  return namedChatConnections(deps, connections, controlledConnectionId);
}

function namedChatConnections(deps, connections, controlledConnectionId) {
  try {
    return {
      controlledConnectionId,
      connections: enrichBrowserConnectionNames(
        connections,
        typeof deps.getTabs === 'function' ? deps.getTabs() : [],
        deps.browserRuntimeManager?.listStates?.() || [],
      ),
    };
  } catch (_) {
    return { connections, controlledConnectionId };
  }
}

function resolveAutomationCards(deps, options) {
  if (options.disableTools) return { automationCards: [] };
  try {
    return { automationCards: listAutomationCards(deps.browserAutomationBridge) };
  } catch (_) {
    return { automationCards: [] };
  }
}

function createChatEmitter(event, options) {
  return (payload) => {
    if (!options.useStream || !options.requestId || !event.sender || event.sender.isDestroyed()) return;
    event.sender.send('ai-control-chat-event', { requestId: options.requestId, ...payload });
  };
}

function prepareChatRequest(deps, event, input, chatRuns, getWindowTools) {
  const access = resolveChatAccess(deps, input);
  if (access.error) return access;
  const options = normalizeChatOptions(input);
  options.initialMessages = buildInlineAttachmentMessages(deps.aiSandboxDir, options.initialMessages);
  if (access.useCustomApi && !access.customApi.supportsTools) options.disableTools = true;
  if (access.useCustomApi && access.customApi.streamOutput === false) options.streamOutput = false;
  const resolvedConnections = resolveConnections(deps, options);
  if (resolvedConnections.error) return resolvedConnections;
  const resolvedCards = resolveAutomationCards(deps, options);
  const windowTools = options.disableTools ? null : getWindowTools();
  const attachmentMessages = buildAttachmentMessages(
    deps.aiSandboxDir, options.attachmentPaths, options.mentions, options.artifactReferences,
  );
  const toolContext = buildChatToolContext({
    connections: resolvedConnections.connections,
    controlledConnectionId: resolvedConnections.controlledConnectionId,
    windowTools,
    automationCards: resolvedCards.automationCards,
    initialMessages: options.initialMessages,
    attachmentMessages,
    localInteraction: options.localInteraction,
  });
  const started = options.useStream && options.requestId ? chatRuns.begin(event, options.requestId) : {};
  return {
    ...access,
    ...options,
    ...started,
    bridge: deps.browserAutomationBridge,
    workspaceDir: deps.aiSandboxDir,
    connections: resolvedConnections.connections,
    controlledConnectionId: resolvedConnections.controlledConnectionId || '',
    emit: createChatEmitter(event, options),
    toolContext,
    windowTools,
  };
}

module.exports = {
  createChatEmitter,
  createIdentityRecovery,
  normalizeChatOptions,
  prepareChatRequest,
  resolveAutomationCards,
  resolveBuiltinAccess,
  resolveChatAccess,
  resolveConnections,
  resolveCustomAccess,
  validateQuota,
};

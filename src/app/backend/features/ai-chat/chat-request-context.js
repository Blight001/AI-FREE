'use strict';

const {
  getCustomAiApiConfig,
  isCustomAiApiConfigured,
  isCustomAiModelId,
} = require('../../utils/ai-control-settings');
const { createVipRequiredResult, resolveVipAccess } = require('../../utils/vip-access');
const { normalizeAccountSession } = require('../../utils/account-session');
const { enrichBrowserConnectionNames } = require('./connection-names');
const { listAutomationCards } = require('./automation-card-service');
const { buildChatToolContext } = require('./chat-tool-context');
const { buildAttachmentMessages } = require('./ai-workspace-service');

function validateQuota(quota) {
  if (!quota || quota.unlimited === true) return null;
  const total = Number(quota.quota);
  const used = Number(quota.used || 0);
  const remaining = Number(quota.remaining ?? (total - used));
  return Number.isFinite(remaining) && remaining <= 0
    ? { ok: false, message: 'AI 对话额度已用尽，请联系管理员', quota }
    : null;
}

function resolveCustomAccess(deps, store, modelId) {
  if (!resolveVipAccess(deps.licenseCache?.getSnapshot?.() || {}).isVip) {
    return { error: createVipRequiredResult('自定义模型') };
  }
  const customApi = getCustomAiApiConfig(store);
  if (!isCustomAiApiConfigured(customApi)) {
    return { error: { ok: false, message: '自定义 API 尚未配置完整，请重新配置' } };
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
  const store = deps.readStoreConfigSafe();
  const modelId = String(input.modelId || '').trim();
  return isCustomAiModelId(modelId)
    ? resolveCustomAccess(deps, store, modelId)
    : resolveBuiltinAccess(deps, store, input, modelId);
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
    initialMessages: Array.isArray(input.messages) ? input.messages : [],
    mentions: Array.isArray(input.mentions) ? input.mentions : [],
    requestId: String(input.requestId || '').trim(),
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
  const controlledConnectionId = preferred || String(connections[0]?.id || '');
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
  const started = options.useStream && options.requestId ? chatRuns.begin(event, options.requestId) : {};
  const resolvedConnections = resolveConnections(deps, options);
  if (resolvedConnections.error) return { ...resolvedConnections, ...started };
  const resolvedCards = resolveAutomationCards(deps, options);
  const windowTools = options.disableTools ? null : getWindowTools();
  const attachmentMessages = buildAttachmentMessages(
    deps.aiSandboxDir, options.attachmentPaths, options.mentions,
  );
  const toolContext = buildChatToolContext({
    connections: resolvedConnections.connections,
    controlledConnectionId: resolvedConnections.controlledConnectionId,
    windowTools,
    automationCards: resolvedCards.automationCards,
    initialMessages: options.initialMessages,
    attachmentMessages,
  });
  return {
    ...access,
    ...options,
    ...started,
    bridge: deps.browserAutomationBridge,
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

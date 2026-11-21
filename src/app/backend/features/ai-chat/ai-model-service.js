'use strict';

const {
  CUSTOM_AI_MODEL_ID,
  getCustomAiApiConfigs,
  isCustomAiApiConfigured,
} = require('../../utils/ai-control-settings');
const { normalizeAccountSession } = require('../../utils/account-session');
const { callOptional, firstText } = require('../../../shared/safe-values');

function createCustomModel(store) {
  return getCustomAiApiConfigs(store).filter(isCustomAiApiConfigured).map((config) => ({
    id: config.id || CUSTOM_AI_MODEL_ID,
    name: config.name,
    model: config.model,
    custom_api: true,
    supports_image_input: config.supportsImageInput,
    supports_tools: config.supportsTools,
  }));
}

function remoteUnavailable(customModel, message = 'AI 服务尚未就绪') {
  return customModel
    ? { ok: true, models: [customModel], quota: null, remoteError: message }
    : { ok: false, message };
}

function createAiModelService(deps = {}) {
  const { readStoreConfigSafe } = deps;
  async function getModels() {
    const store = readStoreConfigSafe();
    const credentials = normalizeAccountSession(store?.userCredentials || {});
    const key = firstText(credentials.key).trim();
    const deviceId = firstText(credentials.deviceId).trim();
    const customModels = createCustomModel(store);
    const appendCustomModels = (models) => [
      ...(Array.isArray(models) ? models : []),
      ...customModels,
    ];
    if (!key || !deviceId) {
      return customModels.length
        ? { ok: true, models: customModels, quota: null }
        : remoteUnavailable(null);
    }
    const httpClient = callOptional(deps, 'getGlobalHttpClient');
    if (!httpClient || typeof httpClient.getAIControlModels !== 'function') {
      return customModels.length
        ? { ok: true, models: customModels, quota: null, remoteError: 'AI 服务尚未就绪' }
        : remoteUnavailable(null);
    }
    const result = await httpClient.getAIControlModels(key, deviceId);
    if (!result || result.ok !== true) {
      return customModels.length
        ? { ok: true, models: customModels, quota: null, remoteError: firstText(result && result.message, result && result.error) }
        : result;
    }
    return {
      ...result,
      models: appendCustomModels(result.models),
    };
  }

  return { getModels };
}

module.exports = { createAiModelService, createCustomModel, remoteUnavailable };

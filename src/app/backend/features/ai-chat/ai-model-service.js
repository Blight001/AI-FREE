'use strict';

const {
  CUSTOM_AI_MODEL_ID,
  getCustomAiApiConfigs,
  isCustomAiApiConfigured,
} = require('../../utils/ai-control-settings');
const { normalizeAccountSession } = require('../../utils/account-session');
const { callOptional, firstText } = require('../../../shared/safe-values');

function customModelName(config) {
  return config.name.replace(/^自定义\s*API(?:\s*[·:：-]\s*|$)/i, '').trim() || config.model;
}

function createCustomModel(store) {
  return getCustomAiApiConfigs(store).filter(isCustomAiApiConfigured).map((config) => ({
    id: config.id || CUSTOM_AI_MODEL_ID,
    name: customModelName(config),
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

function localModelsResult(models, preference, remoteError) {
  if (!models.length) return remoteUnavailable(null, remoteError);
  return { ok: true, models, quota: null, ...preference, ...(remoteError === undefined ? {} : { remoteError }) };
}

async function loadRemoteModels(client, key, deviceId, customModels, preference) {
  const result = await client.getAIControlModels(key, deviceId);
  if (result?.ok !== true) {
    return customModels.length
      ? localModelsResult(customModels, preference, firstText(result?.message, result?.error)) : result;
  }
  return {
    ...result,
    models: [...(Array.isArray(result.models) ? result.models : []), ...customModels],
    lastModelId: preference.lastModelId || '',
  };
}

function createAiModelService(deps = {}) {
  const { readStoreConfigSafe } = deps;
  async function getModels() {
    const store = readStoreConfigSafe();
    const credentials = normalizeAccountSession(store?.userCredentials || {});
    const key = firstText(credentials.key).trim();
    const deviceId = firstText(credentials.deviceId).trim();
    const modelStore = deps.aiModelConfig ? deps.aiModelConfig.readStore() : store;
    const customModels = createCustomModel(modelStore);
    const lastModelId = modelStore?.aiControlSettings?.lastModelId;
    const preference = lastModelId ? { lastModelId } : {};
    if (!key || !deviceId) return localModelsResult(customModels, preference);
    const httpClient = callOptional(deps, 'getGlobalHttpClient');
    if (!httpClient || typeof httpClient.getAIControlModels !== 'function') {
      return localModelsResult(customModels, preference, 'AI 服务尚未就绪');
    }
    return loadRemoteModels(httpClient, key, deviceId, customModels, preference);
  }

  return { getModels };
}

module.exports = { createAiModelService, createCustomModel, remoteUnavailable };

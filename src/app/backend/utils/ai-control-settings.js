const CUSTOM_AI_MODEL_ID = '__custom_openai_api__';

function normalizeCustomAiApiConfig(value = {}) {
  /** @type {Record<string, any>} */
  const source = value && typeof value === 'object' ? value : {};
  return {
    enabled: source.enabled === true,
    name: String(source.name || '自定义 API').trim().slice(0, 80) || '自定义 API',
    baseUrl: String(source.baseUrl || '').trim().slice(0, 2048),
    apiKey: String(source.apiKey || '').trim().slice(0, 4096),
    model: String(source.model || '').trim().slice(0, 200),
    supportsImageInput: source.supportsImageInput === true,
  };
}

function getCustomAiApiConfig(store = {}) {
  return normalizeCustomAiApiConfig(store?.aiControlSettings?.customApi);
}

function isCustomAiApiConfigured(config = {}) {
  const normalized = normalizeCustomAiApiConfig(config);
  return normalized.enabled && Boolean(normalized.baseUrl && normalized.model);
}

function isCustomAiModelId(modelId) {
  return String(modelId || '').trim() === CUSTOM_AI_MODEL_ID;
}

function toPublicCustomAiApiConfig(config = {}) {
  const normalized = normalizeCustomAiApiConfig(config);
  return {
    enabled: normalized.enabled,
    name: normalized.name,
    baseUrl: normalized.baseUrl,
    model: normalized.model,
    supportsImageInput: normalized.supportsImageInput,
    hasApiKey: Boolean(normalized.apiKey),
  };
}

module.exports = {
  CUSTOM_AI_MODEL_ID,
  getCustomAiApiConfig,
  isCustomAiApiConfigured,
  isCustomAiModelId,
  normalizeCustomAiApiConfig,
  toPublicCustomAiApiConfig,
};

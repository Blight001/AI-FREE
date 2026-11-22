const CUSTOM_AI_MODEL_ID = '__custom_openai_api__';
const CUSTOM_AI_MODEL_PREFIX = `${CUSTOM_AI_MODEL_ID}:`;

function normalizeCustomAiApiConfig(value = {}) {
  /** @type {Record<string, any>} */
  const source = value && typeof value === 'object' ? value : {};
  return {
    enabled: source.enabled === true,
    name: String(source.name || '').trim().slice(0, 80) || String(source.model || '').trim().slice(0, 80) || '自定义 API',
    baseUrl: String(source.baseUrl || '').trim().slice(0, 2048),
    apiKey: String(source.apiKey || '').trim().slice(0, 4096),
    model: String(source.model || '').trim().slice(0, 200),
    supportsImageInput: source.supportsImageInput === true,
    supportsTools: source.supportsTools !== false,
    supportsReasoning: source.supportsReasoning !== false,
    streamOutput: source.streamOutput !== false,
    customProtocol: source.customProtocol === true,
    contextWindow: boundedInteger(source.contextWindow, 0, 2000000),
    maxOutputTokens: boundedInteger(source.maxOutputTokens, 0, 2000000),
    id: String(source.id || '').trim().slice(0, 128),
  };
}

function boundedInteger(value, fallback, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(0, Math.floor(number))) : fallback;
}

function getCustomAiApiConfigs(store = {}) {
  const settings = store?.aiControlSettings || {};
  const saved = Array.isArray(settings.customApis) ? settings.customApis : [];
  const legacy = settings.customApi && typeof settings.customApi === 'object'
    ? [settings.customApi]
    : [];
  const configs = Array.isArray(settings.customApis) ? saved : legacy;
  return configs.map((value, index) => {
    const config = normalizeCustomAiApiConfig(value);
    return { ...config, id: config.id || (index === 0 ? CUSTOM_AI_MODEL_ID : `${CUSTOM_AI_MODEL_PREFIX}${index}`) };
  });
}

function getCustomAiApiConfig(store = {}) {
  const configs = getCustomAiApiConfigs(store);
  return configs.find((config) => config.id === CUSTOM_AI_MODEL_ID) || configs[0] || normalizeCustomAiApiConfig({});
}

function getCustomAiApiConfigById(store = {}, modelId) {
  return getCustomAiApiConfigs(store).find((config) => config.id === String(modelId || '').trim()) || null;
}

function isCustomAiApiConfigured(config = {}) {
  const normalized = normalizeCustomAiApiConfig(config);
  return normalized.enabled && Boolean(normalized.baseUrl && normalized.model);
}

function isCustomAiModelId(modelId) {
  const id = String(modelId || '').trim();
  return id === CUSTOM_AI_MODEL_ID || id.startsWith(CUSTOM_AI_MODEL_PREFIX);
}

function toPublicCustomAiApiConfig(config = {}) {
  const normalized = normalizeCustomAiApiConfig(config);
  return {
    enabled: normalized.enabled,
    name: normalized.name,
    baseUrl: normalized.baseUrl,
    model: normalized.model,
    supportsImageInput: normalized.supportsImageInput,
    supportsTools: normalized.supportsTools,
    supportsReasoning: normalized.supportsReasoning,
    streamOutput: normalized.streamOutput,
    customProtocol: normalized.customProtocol,
    contextWindow: normalized.contextWindow,
    maxOutputTokens: normalized.maxOutputTokens,
    id: normalized.id,
    hasApiKey: Boolean(normalized.apiKey),
  };
}

module.exports = {
  CUSTOM_AI_MODEL_ID,
  CUSTOM_AI_MODEL_PREFIX,
  getCustomAiApiConfig,
  getCustomAiApiConfigById,
  getCustomAiApiConfigs,
  isCustomAiApiConfigured,
  isCustomAiModelId,
  normalizeCustomAiApiConfig,
  toPublicCustomAiApiConfig,
};

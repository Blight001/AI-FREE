'use strict';

const crypto = require('node:crypto');
const {
  CUSTOM_AI_MODEL_ID,
  CUSTOM_AI_MODEL_PREFIX,
  getCustomAiApiConfig,
  getCustomAiApiConfigs,
  normalizeCustomAiApiConfig,
  toPublicCustomAiApiConfig,
} = require('../../utils/ai-control-settings');
const { fetchCustomAiModels } = require('../../services/custom-ai-api');

function mergeAiControlSettings(store, patch) {
  const current = store && typeof store === 'object' ? store : {};
  return {
    ...current,
    aiControlSettings: {
      ...(current.aiControlSettings && typeof current.aiControlSettings === 'object' ? current.aiControlSettings : {}),
      ...patch,
    },
  };
}

function validateCustomApiConfig(config, clear = false) {
  if (clear) return;
  if (!config.baseUrl) throw new Error('请输入自定义 API 地址');
  if (!/^https?:\/\//i.test(config.baseUrl)) throw new Error('API 地址必须以 http:// 或 https:// 开头');
  if (!config.model) throw new Error('请输入模型名称');
  if (config.id && config.id !== CUSTOM_AI_MODEL_ID && !config.id.startsWith(CUSTOM_AI_MODEL_PREFIX)) {
    throw new Error('模型 ID 无效');
  }
}

function publicModels(store) {
  return getCustomAiApiConfigs(store).map(toPublicCustomAiApiConfig);
}

function createAiSettingsService(deps = {}) {
  function persist(currentStore, configs) {
    const next = mergeAiControlSettings(currentStore, { customApis: configs });
    delete next.aiControlSettings.customApi;
    if (!deps.writeStore(next)) {
      throw new Error('自定义模型未能写入本地配置');
    }
  }

  function getCustomApi() {
    return { ok: true, config: toPublicCustomAiApiConfig(getCustomAiApiConfig(deps.readStore())) };
  }

  function getCustomApis() {
    return { ok: true, models: publicModels(deps.readStore()) };
  }

  function saveCustomApis(payload = {}) {
    const currentStore = deps.readStore();
    const existing = getCustomAiApiConfigs(currentStore);
    const updates = Array.isArray(payload.models) ? payload.models : [];
    if (!updates.length || updates.length > 64) throw new Error('请选择 1 到 64 个模型');
    const next = [...existing];
    const saved = updates.map((item) => {
      const id = String(item.id || '').trim() || `${CUSTOM_AI_MODEL_PREFIX}${crypto.randomUUID()}`;
      const previous = next.find((entry) => entry.id === id);
      const config = normalizeCustomAiApiConfig({
        ...previous,
        ...item,
        id,
        enabled: true,
        apiKey: Object.prototype.hasOwnProperty.call(item, 'apiKey') ? item.apiKey : previous?.apiKey,
      });
      validateCustomApiConfig(config);
      const index = next.findIndex((entry) => entry.id === id);
      if (index === -1) next.push(config);
      else next[index] = config;
      return config;
    });
    persist(currentStore, next);
    return { ok: true, config: toPublicCustomAiApiConfig(saved[0]), models: getCustomApis().models };
  }

  function saveCustomApi(payload = {}) {
    return saveCustomApis({ models: [payload] });
  }

  function deleteCustomApi(payload = {}) {
    const id = String(payload.id || '').trim();
    if (!id) throw new Error('缺少模型 ID');
    const currentStore = deps.readStore();
    const existing = getCustomAiApiConfigs(currentStore);
    const next = existing.filter((item) => item.id !== id);
    if (next.length === existing.length) throw new Error('模型不存在或已删除');
    persist(currentStore, next);
    return { ok: true, models: getCustomApis().models };
  }

  async function fetchModels(payload = {}) {
    const config = normalizeCustomAiApiConfig(payload);
    if (!config.baseUrl) throw new Error('请先填写 API 地址');
    return { ok: true, models: await (deps.fetchModels || fetchCustomAiModels)(config) };
  }

  function setCustomApi(payload = {}) {
    const currentStore = deps.readStore();
    const existing = getCustomAiApiConfigs(currentStore);
    const legacy = existing.find((item) => item.id === CUSTOM_AI_MODEL_ID) || existing[0];
    if (payload.clear === true) {
      const next = existing.filter((item) => item.id !== (legacy?.id || CUSTOM_AI_MODEL_ID));
      persist(currentStore, next);
      return { ok: true, config: toPublicCustomAiApiConfig(normalizeCustomAiApiConfig({})) };
    }
    const previous = legacy || getCustomAiApiConfig(currentStore);
    const config = normalizeCustomAiApiConfig({
      ...previous,
      ...payload,
      id: previous?.id || CUSTOM_AI_MODEL_ID,
      enabled: payload.enabled !== false,
      apiKey: Object.prototype.hasOwnProperty.call(payload, 'apiKey') ? payload.apiKey : previous.apiKey,
    });
    validateCustomApiConfig(config);
    persist(currentStore, [...existing.filter((item) => item.id !== config.id), config]);
    return { ok: true, config: toPublicCustomAiApiConfig(config) };
  }

  return { deleteCustomApi, fetchModels, getCustomApi, getCustomApis, saveCustomApi, saveCustomApis, setCustomApi };
}

module.exports = { createAiSettingsService, mergeAiControlSettings, publicModels, validateCustomApiConfig };

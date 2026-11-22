'use strict';

const fs = require('node:fs');
const { atomicWrite } = require('./atomic-json');
const { getCustomAiApiConfigs, isCustomAiModelId } = require('../utils/ai-control-settings');

const VERSION = 1;

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readDocument(filePath, label) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    if (!isRecord(value)) throw new Error('Expected a JSON object');
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`无法读取${label}，原文件未被覆盖`);
  }
}

function validateModels(models) {
  if (!Array.isArray(models)) throw new Error('ai-models.json 中的 customApis 必须为数组');
  const ids = new Set();
  for (const model of models) {
    if (!isRecord(model) || typeof model.id !== 'string' || model.id.length > 128
      || !isCustomAiModelId(model.id) || model.id.trim() !== model.id || ids.has(model.id)) {
      throw new Error('ai-models.json 中的模型 ID 无效或重复');
    }
    ids.add(model.id);
  }
}

function loadSettings(document) {
  if (document.version !== VERSION || !isRecord(document.aiControlSettings)) {
    throw new Error('ai-models.json 格式或版本无效，原文件未被覆盖');
  }
  const settings = document.aiControlSettings;
  validateModels(settings.customApis);
  if (typeof settings.lastModelId !== 'string' || settings.lastModelId.length > 512) {
    throw new Error('ai-models.json 中的 lastModelId 无效');
  }
  return settings;
}

function keyCodec(safeStorage) {
  function requireEncryption() {
    if (!safeStorage?.isEncryptionAvailable?.() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('系统凭据加密不可用，无法读写模型 API Key');
    }
  }
  return {
    encode({ apiKey, ...model }) {
      if (!apiKey) return model;
      requireEncryption();
      try {
        return { ...model, encryptedApiKey: safeStorage.encryptString(apiKey).toString('base64') };
      } catch (_) {
        throw new Error('无法加密模型 API Key');
      }
    },
    decode({ encryptedApiKey, ...model }) {
      if (Object.hasOwn(model, 'apiKey') || (encryptedApiKey !== undefined && typeof encryptedApiKey !== 'string')) {
        throw new Error('ai-models.json 中的模型密钥格式无效，请通过「模型设置」管理密钥');
      }
      if (!encryptedApiKey) return model;
      requireEncryption();
      try {
        return { ...model, apiKey: safeStorage.decryptString(Buffer.from(encryptedApiKey, 'base64')) };
      } catch (_) {
        throw new Error('无法解密模型 API Key，请检查是否由当前系统用户保存');
      }
    },
  };
}

function readLegacy(filePath) {
  const store = readDocument(filePath, '旧模型配置');
  const settings = store?.aiControlSettings;
  if (!isRecord(settings) || !['customApi', 'customApis'].some((key) => Object.hasOwn(settings, key))) return null;
  if (Object.hasOwn(settings, 'customApis')
    ? !Array.isArray(settings.customApis) || !settings.customApis.every(isRecord)
    : !isRecord(settings.customApi)) {
    throw new Error('旧模型配置格式无效，原文件未被覆盖');
  }
  return store;
}

function createAiModelConfigRepository({ filePath, getLegacyPath, safeStorage, writeJson = atomicWrite, logger = console }) {
  const codec = keyCodec(safeStorage);
  let legacyCleaned = false;

  function writeStore(store) {
    const settings = store.aiControlSettings;
    const customApis = getCustomAiApiConfigs(store);
    validateModels(customApis);
    const document = { version: VERSION, aiControlSettings: {
      lastModelId: settings.lastModelId || '', customApis: customApis.map(codec.encode),
    } };
    try {
      writeJson(filePath, document);
    } catch (_) {
      throw new Error('模型配置未能写入 ai-models.json，原文件未被覆盖');
    }
    return true;
  }

  function cleanupLegacy(legacyPath, store) {
    if (store) {
      const { customApi: _single, customApis: _list, ...rest } = store.aiControlSettings;
      writeJson(legacyPath, { ...store, aiControlSettings: rest });
    }
    legacyCleaned = true;
  }

  function readStore() {
    const document = readDocument(filePath, ' ai-models.json');
    if (document) {
      const settings = loadSettings(document);
      const store = { aiControlSettings: { ...settings, customApis: settings.customApis.map(codec.decode) } };
      if (!legacyCleaned) {
        try {
          const legacyPath = getLegacyPath();
          cleanupLegacy(legacyPath, readLegacy(legacyPath));
        } catch (_) {
          legacyCleaned = true;
          logger.warn?.('[模型配置] 旧模型配置未清理，下次启动重试');
        }
      }
      return store;
    }
    const legacyPath = getLegacyPath();
    const legacy = readLegacy(legacyPath);
    const store = { aiControlSettings: { lastModelId: '', customApis: getCustomAiApiConfigs(legacy) } };
    if (legacy) {
      writeStore(store);
      return readStore();
    }
    legacyCleaned = true;
    return store;
  }

  return { readStore, writeStore };
}

module.exports = { createAiModelConfigRepository };

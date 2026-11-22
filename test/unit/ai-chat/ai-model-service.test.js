'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createAiModelService, createCustomModel, remoteUnavailable } = require('../../../src/app/backend/features/ai-chat/ai-model-service');

const customStore = {
  aiControlSettings: { customApi: { enabled: true, name: 'Private', baseUrl: 'https://api.example.test', model: 'fixture-model' } },
};

test('custom model requires complete configuration', () => {
  assert.deepEqual(createCustomModel(customStore), [{
    id: '__custom_openai_api__', name: 'Private', model: 'fixture-model', custom_api: true,
    supports_image_input: false,
    supports_tools: true,
  }]);
  assert.deepEqual(createCustomModel({ aiControlSettings: { customApi: { enabled: true } } }), []);
  assert.deepEqual(createCustomModel({}), []);
});

test('custom model service exposes every configured model with stable ids', () => {
  const store = { aiControlSettings: { customApis: [
    { id: '__custom_openai_api__:first', enabled: true, baseUrl: 'https://one.example/v1', model: 'one' },
    { id: '__custom_openai_api__:second', enabled: true, baseUrl: 'https://two.example/v1', model: 'two' },
  ] } };
  assert.deepEqual(createCustomModel(store).map((model) => model.id), ['__custom_openai_api__:first', '__custom_openai_api__:second']);
});

test('the model picker hides old generic labels and preserves explicit display names', () => {
  const modelStore = { aiControlSettings: { customApis: [
    { enabled: true, name: '自定义 API', baseUrl: 'https://api.example.test', model: 'alpha' },
    { enabled: true, name: '自定义API · beta', baseUrl: 'https://api.example.test', model: 'beta' },
    { enabled: true, name: 'My model', baseUrl: 'https://api.example.test', model: 'gamma' },
  ] } };
  assert.deepEqual(createCustomModel(modelStore).map(({ name }) => name), ['alpha', 'beta', 'My model']);
});

test('remote unavailable response preserves an available custom model', () => {
  const model = { id: 'custom' };
  assert.deepEqual(remoteUnavailable(model), { ok: true, models: [model], quota: null, remoteError: 'AI 服务尚未就绪' });
  assert.deepEqual(remoteUnavailable(null, 'offline'), { ok: false, message: 'offline' });
});

test('model service handles missing credentials and unavailable clients', async () => {
  const service = createAiModelService({
    readStoreConfigSafe: () => customStore,
    getGlobalHttpClient: () => null,
  });
  const local = await service.getModels();
  assert.equal(local.ok, true);
  assert.equal(local.models[0].custom_api, true);

  const plain = createAiModelService({ readStoreConfigSafe: () => ({}), getGlobalHttpClient: () => ({}) });
  assert.deepEqual(await plain.getModels(), { ok: false, message: 'AI 服务尚未就绪' });

  const remoteCalls = [];
  const missingCredentials = createAiModelService({
    readStoreConfigSafe: () => ({}),
    getGlobalHttpClient: () => ({
      getAIControlModels: async () => {
        remoteCalls.push(1);
        return { ok: true, models: [{ id: 'remote' }] };
      },
    }),
  });
  assert.deepEqual(await missingCredentials.getModels(), { ok: false, message: 'AI 服务尚未就绪' });
  assert.deepEqual(remoteCalls, []);
});

test('model service merges remote models and degrades remote errors to custom-only', async () => {
  const store = { ...customStore, userCredentials: { sessionToken: 'license', deviceId: 'device' } };
  let response = { ok: true, models: [{ id: 'remote' }], quota: 8 };
  const calls = [];
  const service = createAiModelService({
    readStoreConfigSafe: () => store,
    getGlobalHttpClient: () => ({ getAIControlModels: async (...args) => { calls.push(args); return response; } }),
  });
  const merged = await service.getModels();
  assert.deepEqual(merged.models.map((model) => model.id), ['remote', '__custom_openai_api__']);
  assert.deepEqual(calls, [['license', 'device']]);
  response = { ok: false, error: 'gateway down' };
  const degraded = await service.getModels();
  assert.equal(degraded.ok, true);
  assert.equal(degraded.remoteError, 'gateway down');

  const noCustom = createAiModelService({
    readStoreConfigSafe: () => ({ userCredentials: { sessionToken: 'k', deviceId: 'd' } }),
    getGlobalHttpClient: () => ({ getAIControlModels: async () => ({ ok: false, message: 'denied' }) }),
  });
  assert.deepEqual(await noCustom.getModels(), { ok: false, message: 'denied' });
});

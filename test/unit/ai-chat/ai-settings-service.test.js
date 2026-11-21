'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAiSettingsService } = require('../../../src/app/backend/features/ai-chat/ai-settings-service');

function fixture(overrides = {}) {
  const writes = [];
  const initial = {
    unrelated: { keep: true },
    aiControlSettings: {
      mcpCallLimit: 50,
      customApi: { enabled: true, name: 'Old', baseUrl: 'https://old.example/v1', model: 'old', apiKey: 'secret' },
    },
  };
  const context = {
    readStore: () => writes.at(-1) || initial,
    writeStore: (value) => { writes.push(value); return true; },
    ...overrides,
  };
  return { context, writes };
}

test('自定义 API 可读写且公开结果不泄露 API Key', () => {
  const data = fixture();
  const service = createAiSettingsService(data.context);
  const result = service.setCustomApi({
    name: 'New', baseUrl: 'https://api.example/v1', model: 'next-model',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(data.writes[0].unrelated, { keep: true });
  assert.equal(data.writes[0].aiControlSettings.mcpCallLimit, 50);
  assert.equal(Object.hasOwn(data.writes[0].aiControlSettings, 'customApi'), false);
  assert.equal(data.writes[0].aiControlSettings.customApis[0].apiKey, 'secret');
  assert.equal(Object.prototype.hasOwnProperty.call(result.config, 'apiKey'), false);
  assert.equal(result.config.hasApiKey, true);
  assert.deepEqual(service.getCustomApi(), result);
});

test('无效地址和写入失败返回明确错误，清除配置不要求 VIP', () => {
  const data = fixture();
  const service = createAiSettingsService(data.context);
  assert.throws(() => service.setCustomApi({ baseUrl: 'ftp://api.example', model: 'm' }), /http/);
  const failed = fixture({ writeStore: () => false });
  assert.throws(() => createAiSettingsService(failed.context).setCustomApi({ clear: true }), /未能写入/);
  assert.equal(service.setCustomApi({ clear: true }).config.hasApiKey, false);
});

test('批量模型保存仅写入一次、保留旧 Key 且公开列表不泄露凭据', () => {
  const data = fixture();
  const service = createAiSettingsService(data.context);
  const result = service.saveCustomApis({ models: [
    { name: 'One', baseUrl: 'https://api.example/v1', model: 'one' },
    { name: 'Two', baseUrl: 'https://api.example/v1', model: 'two', apiKey: 'second-secret' },
  ] });
  assert.equal(data.writes.length, 1);
  assert.equal(result.models.length, 3);
  assert.equal(result.models[0].hasApiKey, true);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(data.writes[0].aiControlSettings.customApis[0].apiKey, 'secret');
  assert.equal(data.writes[0].aiControlSettings.customApis[2].apiKey, 'second-secret');
});

test('旧单模型只读兼容并在写入列表后保留；删除最后一项不会复活旧配置', () => {
  const data = fixture();
  const service = createAiSettingsService(data.context);
  assert.equal(service.getCustomApis().models[0].id, '__custom_openai_api__');
  const added = service.saveCustomApi({ name: 'New', baseUrl: 'https://new.example/v1', model: 'new' });
  assert.equal(added.models.length, 2);
  assert.equal(added.models[0].id, '__custom_openai_api__');
  for (const model of added.models) service.deleteCustomApi({ id: model.id });
  assert.deepEqual(service.getCustomApis().models, []);
});

test('批量请求中存在无效模型时不产生部分写入', () => {
  const data = fixture();
  const service = createAiSettingsService(data.context);
  assert.throws(() => service.saveCustomApis({ models: [
    { name: 'Valid', baseUrl: 'https://api.example/v1', model: 'valid' },
    { name: 'Invalid', baseUrl: 'file:///bad', model: 'invalid' },
  ] }), /必须以/);
  assert.equal(data.writes.length, 0);
});

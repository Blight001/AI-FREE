'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAiModelConfigRepository } = require('../../../src/app/backend/platform/ai-model-config-repository');
const { createAiSettingsService } = require('../../../src/app/backend/features/ai-chat/ai-settings-service');
const { createAiModelService } = require('../../../src/app/backend/features/ai-chat/ai-model-service');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-model-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'ai-models.json');
  const legacyPath = path.join(root, 'content');
  const fakeKey = 'fixture-only';
  const cipher = Buffer.from([1, 2, 3]);
  const options = { filePath, getLegacyPath: () => legacyPath, safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value) => { assert.equal(value, fakeKey); return cipher; },
    decryptString: (value) => { assert.deepEqual(value, cipher); return fakeKey; },
  } };
  const initial = { unrelated: true, aiControlSettings: { mcpCallLimit: 4, customApi: {
    enabled: true, baseUrl: 'https://models.example.test', model: 'sample', apiKey: fakeKey,
  } } };
  fs.writeFileSync(legacyPath, JSON.stringify(initial));
  return { root, filePath, legacyPath, options, initial, fakeKey };
}

test('迁移旧模型后加密密钥，保留无关设置和稳定 ID，重开时读取选择', async (t) => {
  const data = fixture(t);
  const models = createAiSettingsService(createAiModelConfigRepository(data.options));
  const [legacy] = models.getCustomApis().models;
  assert.equal(legacy.hasApiKey, true);
  assert.equal(legacy.streamOutput, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(data.legacyPath, 'utf8')), { unrelated: true, aiControlSettings: { mcpCallLimit: 4 } });
  models.setLastModelId(legacy.id);
  models.saveCustomApi({ id: legacy.id, streamOutput: false, name: 'Renamed' });
  const written = fs.readFileSync(data.filePath, 'utf8');
  assert.ok(!written.includes(data.fakeKey));
  assert.deepEqual(fs.readdirSync(data.root).sort(), ['ai-models.json', 'content']);

  const reopened = createAiModelConfigRepository(data.options);
  const picker = createAiModelService({ readStoreConfigSafe: () => ({}), aiModelConfig: reopened });
  assert.equal((await picker.getModels()).lastModelId, legacy.id);
  assert.equal(createAiSettingsService(reopened).getCustomApis().models[0].streamOutput, false);
  assert.equal(reopened.readStore().aiControlSettings.customApis[0].apiKey, data.fakeKey);
  createAiSettingsService(reopened).deleteCustomApi({ id: legacy.id });
  assert.deepEqual(createAiModelConfigRepository(data.options).readStore().aiControlSettings.customApis, []);
});

test('写入失败或配置损坏不会覆盖旧模型，恢复后可重新迁移', (t) => {
  const data = fixture(t);
  const unavailable = createAiModelConfigRepository({ ...data.options, writeJson: () => { throw new Error('disk'); } });
  assert.throws(unavailable.readStore, /未能写入/);
  assert.equal(fs.existsSync(data.filePath), false);
  fs.writeFileSync(data.filePath, '{invalid fixture');
  const reopened = createAiModelConfigRepository(data.options);
  assert.throws(reopened.readStore, /无法读取 ai-models/);
  assert.deepEqual(JSON.parse(fs.readFileSync(data.legacyPath, 'utf8')), data.initial);
  assert.equal(fs.readFileSync(data.filePath, 'utf8'), '{invalid fixture');
  fs.unlinkSync(data.filePath);
  assert.equal(reopened.readStore().aiControlSettings.customApis.length, 1);
});

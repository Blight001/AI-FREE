'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const axios = require('axios');
const { createAiSettingsService } = require('../../src/app/backend/features/ai-chat/ai-settings-service');
const { createAiModelService } = require('../../src/app/backend/features/ai-chat/ai-model-service');
const { createAiChatService } = require('../../src/app/backend/features/ai-chat/ai-chat-service');

const {
  CUSTOM_AI_MODEL_ID,
  getCustomAiApiConfig,
  isCustomAiApiConfigured,
  isCustomAiModelId,
  getCustomAiApiConfigById,
  toPublicCustomAiApiConfig,
} = require('../../src/app/backend/utils/ai-control-settings');
const {
  normalizeMessages,
  normalizeOpenAiTools,
  resolveChatCompletionsUrl,
  resolveModelsUrl,
  fetchCustomAiModels,
  sendCustomAIControlMessage,
} = require('../../src/app/backend/services/custom-ai-api');

test('未登录用户可配置并使用自定义模型，内置模型仍要求登录', async (t) => {
  let store = {};
  const readStoreConfigSafe = () => store;
  const settings = createAiSettingsService({
    readStore: readStoreConfigSafe,
    writeStore: (value) => { store = value; return true; },
  });
  const models = createAiModelService({ readStoreConfigSafe });
  const chat = createAiChatService({ readStoreConfigSafe });
  const provider = t.mock.method(axios, 'post', async () => ({
    status: 200, data: { choices: [{ message: { content: '本地模型回复' } }] },
  }));

  assert.equal(settings.getCustomApi().ok, true);
  assert.equal(settings.setCustomApi({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'local-model' }).ok, true);
  const listed = await models.getModels();
  assert.equal(listed.ok, true);
  assert.equal(listed.models[0].id, CUSTOM_AI_MODEL_ID);
  const messages = [{ role: 'user', content: '你好' }];
  const quota = { remaining: 0 };
  const events = [];
  const event = { sender: { id: 1, isDestroyed: () => false, send: (_channel, payload) => events.push(payload) } };
  const reply = await chat.chat(event, {
    modelId: listed.models[0].id, messages, quota, disableTools: true,
    localInteraction: true, stream: true, requestId: 'custom-sidebar',
  });
  assert.equal(reply.ok, true, reply.ok ? undefined : reply.message);
  assert.equal(reply.message.content, '本地模型回复');
  assert.equal(events.at(-1).type, 'done');
  const builtin = await chat.chat({}, { modelId: 'builtin', messages });
  assert.equal(builtin.ok, false);
  assert.match(builtin.message, /登录/);
  assert.equal(provider.mock.callCount(), 1);
  assert.equal(provider.mock.calls[0].arguments[1].model, 'local-model');
  assert.equal(provider.mock.calls[0].arguments[1].stream, false);

  assert.equal(settings.setCustomApi({ clear: true }).ok, true);
  assert.equal((await models.getModels()).ok, false);
  const missing = await chat.chat({}, { modelId: CUSTOM_AI_MODEL_ID, messages });
  assert.match(missing.message, /尚未配置完整/);
  assert.equal(provider.mock.callCount(), 1);
});

test('自定义 API 配置可识别且公开配置不会泄露 API Key', () => {
  const config = getCustomAiApiConfig({
    aiControlSettings: {
      customApi: {
        enabled: true,
        name: '本地模型',
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiKey: 'secret',
        model: 'qwen3',
      },
    },
  });
  assert.equal(isCustomAiApiConfigured(config), true);
  assert.equal(isCustomAiModelId(CUSTOM_AI_MODEL_ID), true);
  assert.deepEqual(toPublicCustomAiApiConfig(config), {
    enabled: true,
    name: '本地模型',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3',
    supportsImageInput: false,
    supportsTools: true,
    supportsReasoning: true,
    customProtocol: false,
    contextWindow: 0,
    maxOutputTokens: 0,
    id: CUSTOM_AI_MODEL_ID,
    hasApiKey: true,
  });
});

test('聊天根据稳定模型 ID 选择对应的 API 地址、Key 和模型名', async (t) => {
  const calls = [];
  t.mock.method(axios, 'post', async (url, payload, options) => {
    calls.push({ url, payload, options });
    return { status: 200, data: { choices: [{ message: { content: 'second' } }] } };
  });
  const store = { aiControlSettings: { customApis: [
    { id: `${CUSTOM_AI_MODEL_ID}:first`, enabled: true, baseUrl: 'https://first.example/v1', apiKey: 'key-one', model: 'model-one' },
    { id: `${CUSTOM_AI_MODEL_ID}:second`, enabled: true, baseUrl: 'https://second.example/v1', apiKey: 'key-two', model: 'model-two' },
  ] } };
  const modelId = `${CUSTOM_AI_MODEL_ID}:second`;
  const config = getCustomAiApiConfigById(store, modelId);
  const reply = await createAiChatService({ readStoreConfigSafe: () => store }).chat({}, {
    modelId, messages: [{ role: 'user', content: 'hello' }], disableTools: true,
  });
  assert.equal(config.model, 'model-two');
  assert.equal(reply.message.content, 'second');
  assert.equal(calls[0].url, 'https://second.example/v1/chat/completions');
  assert.equal(calls[0].payload.model, 'model-two');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer key-two');
});

test('模型列表 URL 兼容 Base URL 与完整 Chat Completions URL', () => {
  assert.equal(resolveModelsUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/models');
  assert.equal(resolveModelsUrl('https://example.com/api/v2/chat/completions'), 'https://example.com/api/v2/models');
  assert.equal(resolveModelsUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434/v1/models');
  assert.throws(() => resolveModelsUrl('file:///tmp/models'), /仅支持 HTTP/);
});

test('模型发现携带认证、限制跳转并过滤畸形目录项', async (t) => {
  const axiosGet = t.mock.method(axios, 'get', async (url, options) => {
    assert.equal(url, 'https://api.example.test/v1/models');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.equal(options.maxRedirects, 0);
    return { status: 200, data: { data: [{ id: 'gpt-a' }, { id: 'gpt-b', name: 'GPT B' }, { name: 'invalid' }] } };
  });
  const result = await fetchCustomAiModels({ baseUrl: 'https://api.example.test/v1', apiKey: 'test-key' });
  assert.deepEqual(result, [{ id: 'gpt-a', name: 'gpt-a' }, { id: 'gpt-b', name: 'GPT B' }]);
  assert.equal(axiosGet.mock.callCount(), 1);
});

test('自定义 API 地址兼容 Base URL 与完整 Chat Completions URL', () => {
  assert.equal(
    resolveChatCompletionsUrl('https://api.openai.com/v1'),
    'https://api.openai.com/v1/chat/completions',
  );
  assert.equal(
    resolveChatCompletionsUrl('http://127.0.0.1:11434'),
    'http://127.0.0.1:11434/v1/chat/completions',
  );
  assert.equal(
    resolveChatCompletionsUrl('https://example.com/api/v1/chat/completions'),
    'https://example.com/api/v1/chat/completions',
  );
  assert.equal(resolveChatCompletionsUrl('https://example.com/root/?q=1#hash'), 'https://example.com/root/v1/chat/completions');
  assert.throws(() => resolveChatCompletionsUrl('not a url'), /地址无效/);
  assert.throws(() => resolveChatCompletionsUrl('file:///tmp/model'), /仅支持 HTTP/);
});

test('自定义 API 消息归一化保留工具协议并剔除私有字段', () => {
  assert.deepEqual(normalizeMessages(null), []);
  assert.deepEqual(normalizeMessages([
    null,
    { role: 'assistant', content: null, tool_calls: [{ id: 'call' }], private: true },
    { role: 'tool', content: 42, tool_call_id: 9, name: 'lookup' },
    { role: 'tool' },
  ]), [
    { role: 'user', content: '' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call' }] },
    { role: 'tool', content: 42, tool_call_id: '9', name: 'lookup' },
    { role: 'tool', content: '', tool_call_id: '' },
  ]);
});

test('自定义协议按选项保留推理字段，默认 OpenAI 消息不发送', () => {
  const message = { role: 'assistant', content: 'answer', reasoning: 'thought' };
  assert.deepEqual(normalizeMessages([message]), [{ role: 'assistant', content: 'answer' }]);
  assert.deepEqual(normalizeMessages([message], { customProtocol: true }), [
    { role: 'assistant', content: 'answer', reasoning_content: 'thought' },
  ]);
});

test('AI-FREE MCP 工具转换为 OpenAI function tools', () => {
  const schema = { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] };
  assert.deepEqual(normalizeOpenAiTools([
    { name: 'windows_tab', description: '管理窗口', input_schema: schema },
    { type: 'function', function: { name: 'native_tool', description: '原生格式', parameters: schema, strict: true } },
    null,
    { description: '缺少名称' },
  ]), [
    { type: 'function', function: { name: 'windows_tab', description: '管理窗口', parameters: schema } },
    { type: 'function', function: { name: 'native_tool', description: '原生格式', parameters: schema, strict: true } },
  ]);
});

test('自定义 API 请求使用 OpenAI 兼容协议并保留工具调用', async (t) => {
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; });
  let captured;
  axios.post = async (url, payload, options) => {
    captured = { url, payload, options };
    return {
      status: 200,
      data: {
        choices: [{ message: { content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'open_page', arguments: '{}' } }] } }],
      },
    };
  };
  const result = await sendCustomAIControlMessage({
    enabled: true,
    baseUrl: 'https://example.com/v1',
    apiKey: 'token',
    model: 'demo-model',
  }, [{ role: 'user', content: '打开网页', private_field: true }], {
    tools: [{ name: 'open_page', description: '打开网页', input_schema: { type: 'object' } }],
  });
  assert.equal(result.ok, true);
  assert.equal(captured.url, 'https://example.com/v1/chat/completions');
  assert.equal(captured.options.headers.Authorization, 'Bearer token');
  assert.equal(captured.payload.model, 'demo-model');
  assert.equal(captured.payload.messages[0].private_field, undefined);
  assert.deepEqual(captured.payload.tools, [{
    type: 'function',
    function: { name: 'open_page', description: '打开网页', parameters: { type: 'object' } },
  }]);
  assert.equal(result.message.tool_calls[0].function.name, 'open_page');
});

test('自定义 API 请求覆盖未配置、HTTP 错误、响应变体与网络错误', async (t) => {
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; });
  assert.deepEqual(await sendCustomAIControlMessage({}, []), { ok: false, message: '自定义 API 尚未配置完整' });
  const config = { enabled: true, baseUrl: 'https://example.com', model: 'fixture' };
  axios.post = async () => ({ status: 429, data: { error: { message: 'rate limited' } } });
  assert.match((await sendCustomAIControlMessage(config, [])).message, /rate limited/);
  axios.post = async () => ({ status: 500, data: { message: 'server failed' } });
  assert.match((await sendCustomAIControlMessage(config, [])).message, /server failed/);
  axios.post = async () => ({ status: 503, data: 'plain' });
  assert.match((await sendCustomAIControlMessage(config, [])).message, /HTTP 503/);
  axios.post = async () => ({ status: 200, data: {} });
  assert.match((await sendCustomAIControlMessage(config, [])).message, /缺少 choices/);
  axios.post = async () => ({ status: 200, data: { choices: [{ message: {
    content: ['hello', { text: ' world' }, { content: '!' }, null], reasoning: 'thought', tool_calls: null,
  } }], usage: { total_tokens: 3 } } });
  const success = await sendCustomAIControlMessage(config, []);
  assert.equal(success.message.content, 'hello world!');
  assert.equal(success.message.reasoning, 'thought');
  assert.deepEqual(success.message.tool_calls, []);
  axios.post = async () => { throw new Error('network offline'); };
  assert.match((await sendCustomAIControlMessage(config, [])).message, /network offline/);
});

test('未启用图片输入的自定义模型在请求前返回明确错误', async (t) => {
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; });
  let requests = 0;
  axios.post = async () => { requests += 1; return {}; };
  const result = await sendCustomAIControlMessage({
    enabled: true,
    name: '纯文本模型',
    baseUrl: 'https://example.com/v1',
    model: 'text-only',
  }, [{ role: 'user', content: [
    { type: 'text', text: '分析截图' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
  ] }]);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'MODEL_IMAGE_INPUT_UNSUPPORTED');
  assert.match(result.message, /纯文本模型.*未启用图片输入/);
  assert.equal(requests, 0);
});

test('自定义 API 归一化旧式 function_call 与 Anthropic tool_use', async (t) => {
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; });
  const config = { enabled: true, baseUrl: 'https://example.com', model: 'fixture' };
  const responses = [
    { choices: [{ message: { content: '', function_call: { name: 'software_window', arguments: '{"action":"list"}' } } }] },
    { choices: [{ message: { content: [
      { type: 'text', text: '正在获取窗口' },
      { type: 'tool_use', id: 'anthropic-1', name: 'software_window', input: { action: 'list' } },
    ] } }] },
  ];
  axios.post = async () => ({ status: 200, data: responses.shift() });
  const legacy = await sendCustomAIControlMessage(config, []);
  assert.equal(legacy.message.tool_calls[0].function.name, 'software_window');
  assert.deepEqual(JSON.parse(legacy.message.tool_calls[0].function.arguments), { action: 'list' });
  const anthropic = await sendCustomAIControlMessage(config, []);
  assert.equal(anthropic.message.content, '正在获取窗口');
  assert.equal(anthropic.message.tool_calls[0].id, 'anthropic-1');
  assert.deepEqual(JSON.parse(anthropic.message.tool_calls[0].function.arguments), { action: 'list' });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createAiChatService,
  waitForBrowserConnection,
} = require('../../../src/app/backend/features/ai-chat/ai-chat-service');

function eventFixture(id = 1) {
  const sent = [];
  return {
    sent,
    event: {
      sender: {
        id,
        isDestroyed: () => false,
        send: (channel, payload) => sent.push({ channel, payload }),
      },
    },
  };
}

function createService(client, overrides = {}) {
  return createAiChatService({
    readStoreConfigSafe: () => ({ userCredentials: { sessionToken: 'key', deviceId: 'device' } }),
    getGlobalHttpClient: () => client,
    licenseCache: { getSnapshot: () => ({}) },
    logger: { warn() {} },
    ...overrides,
  });
}

test('等待新窗口对应的自动化 MCP 连接后返回完整连接', async () => {
  const connection = { id: 'mcp-1', name: '新窗口', tools: [{ name: 'browser_tab' }] };
  const found = await waitForBrowserConnection({
    browserAutomationBridge: {
      listConnections: () => [connection],
      getConnection: () => connection,
    },
    getTabs: () => [],
    browserRuntimeManager: { listStates: () => [] },
  }, { name: '新窗口' }, 100);
  assert.equal(found.id, 'mcp-1');
});

test('AI 默认工具包含 AI-Workspace 命令执行入口', async (t) => {
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-chat-workspace-'));
  t.after(() => fs.rmSync(sandboxDir, { recursive: true, force: true }));
  const service = createService({}, {
    aiSandboxDir: sandboxDir,
    browserWindowUi: { getTabs: () => new Map() },
  });
  const tools = service.getWindowTools();
  assert.equal(tools.has('run_command'), true);
  assert.deepEqual(tools.tools.map((tool) => tool.name), ['windows_tab', 'browser_environment', 'run_command']);
  const command = process.platform === 'win32' ? 'echo ready' : 'printf ready';
  assert.match((await tools.execute('run_command', { command })).stdout, /ready/);
});

test('内置模型正常返回完整消息链并发布流式完成事件', async () => {
  const client = {
    sendAIControlMessage: async () => ({ ok: true, quota: { remaining: 9 }, message: { role: 'assistant', content: '完成' } }),
  };
  const service = createService(client);
  const fixture = eventFixture();
  const result = await service.chat(fixture.event, {
    modelId: 'builtin',
    messages: [{ role: 'user', content: '开始' }],
    disableTools: true,
    stream: true,
    requestId: 'request-1',
  });
  assert.equal(result.ok, true);
  assert.equal(result.messages.at(-1).content, '完成');
  assert.equal(result.quota.remaining, 9);
  assert.equal(fixture.sent.at(-1).payload.type, 'done');
});

test('工具回合后模型失败时仍保留本次请求已确认的扣费', async () => {
  let round = 0;
  const client = { sendAIControlMessage: async () => [
    { ok: true, quota_cost: 0.25, message: { role: 'assistant', tool_calls: [{ id: 'one',
      function: { name: 'lookup', arguments: '{}' } }] } },
    { ok: true, quota_cost: 0.5, quota_cost_increment: 0.25, message: { role: 'assistant', tool_calls: [{ id: 'two',
      function: { name: 'lookup', arguments: '{}' } }] } },
    { ok: false, message: '服务暂不可用' },
  ][round++] };
  const service = createService(client, { getParentChatTools: () => ({
    tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
    has: (name) => name === 'lookup', execute: () => ({ ok: true }),
  }) });
  const result = await service.chat(eventFixture().event, {
    modelId: 'builtin', messages: [{ role: 'user', content: '查询' }],
  });
  assert.equal(round, 3);
  assert.equal(result.ok, false);
  assert.equal(result.quotaUsed, 0.5);
});

test('长对话只压缩模型请求副本，返回的持久化历史保持完整', async () => {
  let sentMessages = [];
  const client = {
    sendAIControlMessage: async (_key, _deviceId, _modelId, messages) => {
      sentMessages = structuredClone(messages);
      return { ok: true, message: { role: 'assistant', content: '完成' } };
    },
  };
  const history = Array.from({ length: 100 }, (_, index) => [
    { role: 'user', content: `问题-${index}-${'内容'.repeat(600)}` },
    { role: 'assistant', content: `回答-${index}-${'结论'.repeat(600)}` },
  ]).flat();
  const service = createService(client);
  const result = await service.chat(eventFixture().event, {
    modelId: 'builtin', messages: history, disableTools: true,
  });

  assert.ok(JSON.stringify({ messages: sentMessages, tools: [] }).length <= 60000);
  assert.match(sentMessages[0].content, /较早对话摘要/);
  assert.equal(result.messages.length, history.length + 1);
  assert.equal(result.messages[0].content, history[0].content);
});

test('额度耗尽时不调用模型服务', async () => {
  let calls = 0;
  const service = createService({ sendAIControlMessage: async () => { calls += 1; return { ok: true }; } });
  const result = await service.chat(eventFixture().event, {
    modelId: 'builtin',
    quota: { quota: 1, used: 1 },
    messages: [{ role: 'user', content: '开始' }],
    disableTools: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /额度已用尽/);
  assert.equal(calls, 0);
});

test('身份失效时通过已绑定设备刷新凭据并只重试当前模型请求', async () => {
  const credentials = { sessionToken: 'old-key', deviceId: 'device' };
  const calls = [];
  let recoveryCalls = 0;
  const client = {
    sendAIControlMessage: async (key, deviceId) => {
      calls.push([key, deviceId]);
      return calls.length === 1
        ? { ok: false, status: 403, message: '登录状态无效，请重新登录' }
        : { ok: true, message: { role: 'assistant', content: '已恢复' } };
    },
  };
  const service = createService(client, {
    readStoreConfigSafe: () => ({ userCredentials: credentials }),
    accountService: {
      authenticate: async ({ mode }) => {
        assert.equal(mode, 'device');
        recoveryCalls += 1;
        credentials.sessionToken = 'new-key';
        return { ok: true };
      },
    },
  });
  const result = await service.chat(eventFixture().event, {
    modelId: 'builtin', messages: [{ role: 'user', content: '开始' }], disableTools: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.message.content, '已恢复');
  assert.equal(recoveryCalls, 1);
  assert.deepEqual(calls, [['old-key', 'device'], ['new-key', 'device']]);
});

test('流式输出可停止并保留已到达的部分内容，完成后连续停止幂等', async () => {
  const client = {
    sendAIControlMessage: async () => ({ ok: true }),
    streamAIControlMessage: async (_key, _device, _model, _messages, options, onEvent) => {
      onEvent({ type: 'content_delta', delta: '部分结果' });
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('stopped');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
  };
  const service = createService(client);
  const fixture = eventFixture(8);
  const pending = service.chat(fixture.event, {
    modelId: 'builtin', messages: [{ role: 'user', content: '开始' }],
    disableTools: true, stream: true, requestId: 'stop-me',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await service.stop(fixture.event, { requestId: 'stop-me' }), { ok: true, stopped: true });
  const result = await pending;
  assert.equal(result.stopped, true);
  assert.equal(result.message.content, '部分结果');
  assert.deepEqual(await service.stop(fixture.event, { requestId: 'stop-me' }), { ok: true, stopped: false });
});

test('continuation resumes the interrupted round with completed tool results and no extra user message', { timeout: 3000 }, async () => {
  const { event, sent } = eventFixture(12);
  const seen = [];
  const connection = { id: 'local-fixture', tools: [{ name: 'fixture_read', input_schema: { type: 'object' } }] };
  let toolCalls = 0;
  const bridge = {
    listConnections: () => [connection], getConnection: () => connection,
    dispatch: async () => { toolCalls++; return { success: true, value: 42 }; },
  };
  let modelWaiting;
  const waiting = new Promise((resolve) => { modelWaiting = resolve; });
  const service = createService({
    sendAIControlMessage: async () => assert.fail('Expected the stream transport'),
    async streamAIControlMessage(_key, _device, _model, messages, { signal }, onEvent) {
      seen.push(structuredClone(messages));
      if (seen.length === 1) return { ok: true, quota_cost_increment: 0.125, message: { tool_calls: [{ id: 'one',
        function: { name: 'fixture_read', arguments: '{}' } }] } };
      if (seen.length === 2) {
        onEvent({ type: 'content_delta', delta: 'partial' });
        modelWaiting();
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      return { ok: true, quota_cost_increment: 0.25, message: { content: 'Resumed' } };
    },
  }, { browserAutomationBridge: bridge });
  const pending = service.chat(event, {
    modelId: 'builtin', messages: [{ role: 'user', content: 'start' }], stream: true, requestId: 'original',
  });
  await Promise.race([waiting, pending.then((result) => assert.fail(JSON.stringify(result)))]);
  await service.stop(event, { requestId: 'original' });
  const stopped = await pending;
  assert.equal(stopped.resumable, true);
  assert.equal(stopped.quotaUsed, 0.125);
  const resume = { stream: true, requestId: 'next', resumeRequestId: 'original' };
  assert.equal((await service.chat(eventFixture(13).event, resume)).ok, false);
  const resumed = await service.chat(event, resume);
  assert.equal(resumed.message.content, 'Resumed');
  assert.equal(resumed.quotaUsed, 0.25);
  assert.equal(toolCalls, 1);
  assert.equal(JSON.parse(seen[1].at(-1).content).value, 42);
  assert.deepEqual(seen[2], seen[1]);
  assert.deepEqual(resumed.messages.filter(({ role }) => role === 'user'), [{ role: 'user', content: 'start' }]);
  assert.equal(sent.find(({ payload }) => payload.requestId === 'next').payload.type, 'round_start');
  assert.equal((await service.chat(event, { ...resume, requestId: 'again' })).ok, false);
});

test('continuation reports interrupted and unstarted tools without replaying the batch', { timeout: 3000 }, async () => {
  const { event } = eventFixture(14);
  const seen = [];
  const dispatched = [];
  const connection = { id: 'local-fixture', tools: [{ name: 'fixture_read', input_schema: { type: 'object' } }] };
  let notifyDispatch;
  const dispatchStarted = new Promise((resolve) => { notifyDispatch = resolve; });
  const bridge = {
    listConnections: () => [connection], getConnection: () => connection,
    dispatch: async (_id, _name, { number }, { signal }) => {
      dispatched.push(number);
      if (number === 1) return { success: true, number };
      notifyDispatch();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  };
  const service = createService({
    async sendAIControlMessage(_key, _device, _model, messages) {
      seen.push(messages);
      if (seen.length > 1) return { ok: true, message: { content: 'Reviewed' } };
      return { ok: true, message: { tool_calls: [1, 2, 3].map((number) => ({ id: String(number),
        function: { name: 'fixture_read', arguments: JSON.stringify({ number }) },
      })) } };
    },
  }, { browserAutomationBridge: bridge });
  const pending = service.chat(event, {
    modelId: 'builtin', messages: [{ role: 'user', content: 'start' }], stream: true, requestId: 'batch',
  });
  await Promise.race([dispatchStarted, pending.then((result) => assert.fail(JSON.stringify(result)))]);
  await service.stop(event, { requestId: 'batch' });
  assert.equal((await pending).resumable, true);
  const resumed = await service.chat(event, { stream: true, requestId: 'next', resumeRequestId: 'batch' });
  assert.equal(resumed.message.content, 'Reviewed');
  assert.deepEqual(dispatched, [1, 2]);
  const results = seen[1].filter(({ role }) => role === 'tool').map(({ content }) => JSON.parse(content));
  assert.equal(results[0].number, 1);
  assert.equal(results[1].errorCode, 'AI_TOOL_OUTCOME_UNCONFIRMED');
  assert.equal(results[2].errorCode, 'AI_TOOL_NOT_STARTED');
});

test('a full offline sidebar conversation lists cards and returns their IDs to the model', async () => {
  let calls = 0;
  const service = createService({
    async sendAIControlMessage(_key, _device, _model, messages) {
      if (++calls === 1) return { ok: true, message: { role: 'assistant', tool_calls: [
        { id: 'list', function: { name: 'manage_card', arguments: '{"action":"list"}' } },
      ] } };
      assert.equal(JSON.parse(messages.at(-1).content).items[0].id, 'offline-card');
      return { ok: true, message: { role: 'assistant', content: 'Found the card' } };
    },
  }, { browserAutomationBridge: { listConnections: () => [], async manageCard(id, args) {
    assert.equal(id, ''); assert.equal(args.action, 'list');
    return { success: true, items: [{ id: 'offline-card' }] };
  } } });
  const result = await service.chat(eventFixture().event, { localInteraction: true, modelId: 'builtin',
    messages: [{ role: 'user', content: '列出本地卡片' }] });
  assert.equal(result.ok, true, result.message?.content || result.message);
  assert.equal(calls, 2);
});

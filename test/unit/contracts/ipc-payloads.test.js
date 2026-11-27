// 单元测试：集中 IPC payload schema 与兼容 handler 包装。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.join(__dirname, '..', '..', '..');
const {
  IpcPayloadError,
  validateIpcPayload,
  wrapLegacyIpcEventPayload,
  wrapLegacyIpcPayload,
} = require(path.join(root, 'src', 'app', 'contracts', 'ipc-payloads.js'));

test('provider account save accepts optional notes and validates type and length', () => {
  const channel = 'provider-accounts-save';
  const input = { provider: 'google', email: 'fixture@example.test', password: 'fixture-only' };
  assert.deepEqual(validateIpcPayload(channel, input), input);
  for (const extra of [{ note: '备用账号' }, { smsUrl: 'https://sms.example.test/inbox' }]) {
    const payload = { ...input, ...extra };
    assert.deepEqual(validateIpcPayload(channel, payload), payload);
  }
  for (const note of [123, 'x'.repeat(2049)]) {
    assert.throws(() => validateIpcPayload(channel, { ...input, note }),
      (error) => error instanceof IpcPayloadError && error.details.path === 'note');
  }
});

test('AI 历史 ID schema 接受兼容对象并拒绝错误字段类型', () => {
  const input = { id: 'session-1', compatibilityField: true };
  assert.equal(validateIpcPayload('ai-control-history-get', input), input);
  assert.deepEqual(
    validateIpcPayload('ai-control-history-get', { id: 'session-1', setCurrent: false }),
    { id: 'session-1', setCurrent: false },
  );
  assert.throws(() => validateIpcPayload('ai-control-history-get', { id: 'session-1', setCurrent: 'false' }),
    (error) => error instanceof IpcPayloadError && error.details.path === 'setCurrent');

  assert.throws(
    () => validateIpcPayload('ai-control-history-delete', { id: 123 }),
    (error) => error instanceof IpcPayloadError
      && error.code === 'IPC_INVALID_PAYLOAD'
      && error.details.path === 'id',
  );
});

test('AI 历史保存兼容嵌套、旧版直接 session 和长消息列表', () => {
  const nested = { session: { id: 's1', messages: [{ role: 'user', content: 'hi' }] }, setCurrent: true };
  const direct = { id: 's2', messages: [] };
  assert.equal(validateIpcPayload('ai-control-history-save', nested), nested);
  assert.equal(validateIpcPayload('ai-control-history-save', direct), direct);

  const largeHistory = { session: { messages: new Array(129).fill({ role: 'user', content: 'x' }) } };
  assert.equal(validateIpcPayload('ai-control-history-save', largeHistory), largeHistory);
});

test('可选 AI payload 保留既有省略参数行为，数组成员仍逐项校验', () => {
  assert.deepEqual(validateIpcPayload('ai-control-history-create', undefined), {});
  assert.throws(
    () => validateIpcPayload('ai-control-browser-selection-changed', { profileIds: ['ok', 2] }),
    (error) => error instanceof IpcPayloadError && error.details.path === 'profileIds[]',
  );
});

test('AI 长文本粘贴导入校验文本载荷并限制大小', () => {
  const channel = 'ai-control-workspace-import-pasted';
  const payload = { text: 'large pasted text' };
  assert.deepEqual(validateIpcPayload(channel, payload), payload);
  assert.throws(() => validateIpcPayload(channel, { text: 7 }),
    (error) => error instanceof IpcPayloadError && error.details.path === 'text');
  assert.throws(() => validateIpcPayload(channel, { text: 'x'.repeat(2 * 1024 * 1024 + 1) }),
    (error) => error instanceof IpcPayloadError && error.details.path === 'text');
});

test('AI 剪贴板文件导入限制文件数量与 payload 字段', () => {
  const channel = 'ai-control-workspace-import-pasted';
  const payload = { files: [{ name: 'image.png', data: 'aGVsbG8=' }] };
  assert.deepEqual(validateIpcPayload(channel, payload), payload);
  assert.throws(() => validateIpcPayload(channel, { files: [{ name: 'x', data: 1 }] }),
    (error) => error instanceof IpcPayloadError && error.details.path === 'files[0].data');
  assert.throws(() => validateIpcPayload(channel, { files: [] }),
    (error) => error instanceof IpcPayloadError && error.details.path === 'files');
});

test('legacy invoke 包装在 handler 前拦截非法输入并保持旧返回形状', async () => {
  let called = false;
  const handler = wrapLegacyIpcPayload('ai-control-redeem-gift-code', async () => {
    called = true;
    return { ok: true };
  });

  const result = await handler({}, { code: { secret: 'do-not-log' } });
  assert.equal(called, false);
  assert.deepEqual(result, {
    ok: false,
    code: 'IPC_INVALID_PAYLOAD',
    message: '请求参数无效：code 必须是字符串',
  });
  assert.doesNotMatch(JSON.stringify(result), /do-not-log/);
});

test('legacy event 包装丢弃非法事件，日志只含字段诊断而不含原值', () => {
  let called = false;
  const warnings = [];
  const listener = wrapLegacyIpcEventPayload(
    'ai-control-browser-selection-changed',
    () => { called = true; },
    { warn: (...args) => warnings.push(args) },
  );

  listener({}, { profileIds: [{ token: 'sensitive-value' }] });
  assert.equal(called, false);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][1].errorCode, 'IPC_INVALID_PAYLOAD');
  assert.doesNotMatch(JSON.stringify(warnings), /sensitive-value/);
});

test('完整聊天 schema 校验消息、配额、连接和流式控制字段', () => {
  const input = {
    modelId: 'model-1',
    requestId: 'request-1',
    messages: [{ role: 'user', content: 'hello' }],
    quota: { remaining: 10 },
    browserConnectionIds: ['browser-1'],
    stream: true,
  };
  assert.equal(validateIpcPayload('ai-control-chat', input), input);
  assert.throws(
    () => validateIpcPayload('ai-control-chat', { messages: [{ role: 3, content: 'bad' }] }),
    (error) => error instanceof IpcPayloadError && error.details.path === 'messages[0].role',
  );
  assert.throws(
    () => validateIpcPayload('ai-control-chat', { quota: [] }),
    (error) => error instanceof IpcPayloadError && error.details.path === 'quota',
  );
});

test('AI 工作流 schema 允许报告详情开关', () => {
  assert.deepEqual(validateIpcPayload('ai-control-workflow', {
    connection_id: 'browser-1',
    action: 'report',
    include_details: true,
  }), {
    connection_id: 'browser-1',
    action: 'report',
    include_details: true,
  });
  assert.throws(
    () => validateIpcPayload('ai-control-workflow', {
      connection_id: 'browser-1',
      action: 'report',
      include_details: 'yes',
    }),
    IpcPayloadError,
  );
});

test('自定义 API schema 限制敏感字段形状', () => {
  assert.throws(
    () => validateIpcPayload('set-ai-control-custom-api', { apiKey: { raw: 'secret' } }),
    (error) => error instanceof IpcPayloadError && error.details.path === 'apiKey',
  );
});

test('AI 服务器设备登录 schema 限制连接字段形状', () => {
  assert.deepEqual(validateIpcPayload('login-ai-server-device', {
    server: 'http://49.234.181.190:3000',
    account: 'alice',
    password: 'secret',
    serviceName: 'AI-FREE',
  }), {
    server: 'http://49.234.181.190:3000',
    account: 'alice',
    password: 'secret',
    serviceName: 'AI-FREE',
  });
  assert.throws(
    () => validateIpcPayload('login-ai-server-device', { password: { raw: 'secret' } }),
    (error) => error instanceof IpcPayloadError && error.details.path === 'password',
  );
});

test('账号认证和礼品码 schema 限制边界字段类型', () => {
  assert.deepEqual(
    validateIpcPayload('account-authenticate', { mode: 'login', username: 'alice', password: 'secret' }),
    { mode: 'login', username: 'alice', password: 'secret' },
  );
  assert.throws(() => validateIpcPayload('account-authenticate', { password: 123 }), IpcPayloadError);
  assert.throws(() => validateIpcPayload('redeem-vip-gift-code', { code: false }), IpcPayloadError);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createChatEmitter,
  createIdentityRecovery,
  normalizeChatOptions,
  resolveAutomationCards,
  resolveChatAccess,
  resolveConnections,
  validateQuota,
} = require('../../../src/app/main/features/ai-chat/chat-request-context');

test('额度边界和旧多选输入被归一化为单一控制浏览器', () => {
  assert.equal(validateQuota({ unlimited: true, remaining: 0 }), null);
  assert.equal(validateQuota({ quota: 10, used: 10 }).ok, false);
  assert.equal(validateQuota({ quota: 10, remaining: 1 }), null);
  assert.deepEqual(
    normalizeChatOptions({ browserConnectionIds: [' a ', 'a', '', 'b'], stream: true, requestId: ' r ' }).connectionIds,
    ['a'],
  );
  const options = normalizeChatOptions({
    attachmentPaths: [' notes.md ', 'notes.md', ''],
    mentions: [{ type: 'file', label: 'notes.md', reference: 'notes.md', detail: '说明' }],
  });
  assert.deepEqual(options.attachmentPaths, ['notes.md']);
  assert.equal(options.mentions[0].reference, 'notes.md');
});

test('内置模型要求登录和服务可用，自定义模型同时要求 VIP 与完整配置', () => {
  const base = { readStoreConfigSafe: () => ({}), getGlobalHttpClient: () => null, licenseCache: { getSnapshot: () => ({}) } };
  assert.match(resolveChatAccess(base, { modelId: 'builtin' }).error.message, /登录/);
  const signedIn = {
    ...base,
    readStoreConfigSafe: () => ({ userCredentials: { sessionToken: 'afs_session', deviceId: 'device' } }),
    getGlobalHttpClient: () => ({ sendAIControlMessage() {} }),
  };
  assert.equal(resolveChatAccess(signedIn, { modelId: 'builtin' }).key, 'afs_session');
  assert.equal(resolveChatAccess(base, { modelId: '__custom_openai_api__' }).error.code, 'VIP_REQUIRED');
  const vip = { ...base, licenseCache: { getSnapshot: () => ({ is_vip: true, vip_active: true, vip_server_verified: true, vip_verified_at: new Date().toISOString() }) } };
  assert.match(resolveChatAccess(vip, { modelId: '__custom_openai_api__' }).error.message, /尚未配置完整/);
});

test('对话会装入全部在线浏览器，不因用户未选择或旧连接离线而失败', () => {
  const empty = resolveConnections({ browserAutomationBridge: { listConnections: () => [] } }, {
    disableTools: false, connectionIds: ['stale'],
  });
  assert.equal(empty.error, undefined);
  assert.deepEqual(empty.connections, []);
  assert.equal(empty.controlledConnectionId, '');

  const one = { id: 'one', name: 'Browser' };
  const two = { id: 'two', name: 'Other' };
  const found = resolveConnections({
    browserAutomationBridge: {
      listConnections: () => [one, two],
      getConnection: (id) => [one, two].find((item) => item.id === id),
    },
    getTabs: () => [],
    browserRuntimeManager: { listStates: () => [] },
  }, { disableTools: false, connectionIds: [] });
  assert.equal(found.connections.length, 2);
  assert.equal(found.controlledConnectionId, 'one');

  const preferred = resolveConnections({
    browserAutomationBridge: {
      listConnections: () => [one, two],
      getConnection: (id) => [one, two].find((item) => item.id === id),
    },
    getTabs: () => [],
    browserRuntimeManager: { listStates: () => [] },
  }, { disableTools: false, connectionIds: ['stale', 'two'] });
  assert.equal(preferred.controlledConnectionId, 'two');
  assert.equal(preferred.connections.length, 2);
});

test('对话上下文读取全部自动化卡片，不再绑定用户选择', () => {
  const cards = resolveAutomationCards({
    browserAutomationBridge: {
      getCardCacheState: () => ({
        exists: true,
        state: {
          selectedId: 'ignored',
          items: [
            { id: 'a', cardName: '登录', cardData: { website: 'https://a.example', description: 'A', steps: [{}] } },
            { id: 'b', cardName: '下单', cardData: { website: 'https://b.example', steps: [{}, {}] } },
          ],
        },
      }),
    },
  }, { disableTools: false });
  assert.equal(cards.automationCards.length, 2);
  assert.equal(cards.automationCards[0].id, 'a');
  assert.equal(cards.automationCards[1].name, '下单');
  assert.equal(resolveAutomationCards({}, { disableTools: true }).automationCards.length, 0);
});

test('流式事件仅发送到仍存活的原请求窗口', () => {
  const sent = [];
  const sender = { destroyed: false, isDestroyed() { return this.destroyed; }, send: (...args) => sent.push(args) };
  const emit = createChatEmitter({ sender }, { useStream: true, requestId: 'request-1' });
  emit({ type: 'done' });
  sender.destroyed = true;
  emit({ type: 'late' });
  assert.deepEqual(sent, [['ai-control-chat-event', { requestId: 'request-1', type: 'done' }]]);
});

test('设备登录恢复器只在认证成功后返回最新持久化凭据', async () => {
  let current = { sessionToken: 'old', deviceId: 'device' };
  const recovery = createIdentityRecovery({
    accountService: {
      authenticate: async () => {
        current = { sessionToken: 'new', deviceId: 'device' };
        return { ok: true };
      },
    },
    readStoreConfigSafe: () => ({ userCredentials: current }),
  });
  assert.deepEqual(await recovery(), { key: 'new', deviceId: 'device' });
  assert.equal(createIdentityRecovery({}), null);
});

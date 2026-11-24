'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { aiControlMessageWindowStart } = require('../../../src/app/frontend/sidebar/client/app/side/controllers/pages/ai-control/ai-control-message-window');

function conversation(turns) {
  return turns.flatMap((count) => [
    { role: 'user' },
    ...Array.from({ length: count }, () => ({ role: 'assistant' })),
  ]);
}

test('初始消息窗口从最新完整用户轮次开始并限制 DOM 消息量', () => {
  const messages = conversation([20, 5, 30]);
  const start = aiControlMessageWindowStart(messages, messages.length, 24);
  assert.equal(messages[start].role, 'user');
  assert.ok(messages.length - start >= 24);
  assert.ok(messages.length - start < 24 + 32);
});

test('向上分页从上一轮用户消息开始，第一页从索引零开始', () => {
  const messages = conversation([15, 15, 15, 15]);
  const end = aiControlMessageWindowStart(messages, messages.length, 20);
  const start = aiControlMessageWindowStart(messages, end, 20);
  assert.equal(messages[start].role, 'user');
  assert.ok(start < end);
  assert.equal(aiControlMessageWindowStart(messages, 0, 20), 0);
  assert.equal(aiControlMessageWindowStart(messages, 8, 20), 0);
});
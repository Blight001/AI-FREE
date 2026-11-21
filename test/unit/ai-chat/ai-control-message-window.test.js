'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { limitAiControlMessages } = require('../../../src/app/backend/lib/ai-control-message-window');

test('输入上下文裁剪保留系统提示和最新完整用户轮次', () => {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'old '.repeat(300) },
    { role: 'assistant', content: 'old answer '.repeat(300) },
    { role: 'user', content: 'latest' },
    { role: 'assistant', content: 'latest answer' },
  ];
  const limited = limitAiControlMessages(messages, 80);
  assert.equal(limited[0].role, 'system');
  assert.equal(limited.some((message) => message.content === 'old '.repeat(300)), false);
  assert.deepEqual(limited.slice(-2).map((message) => message.content), ['latest', 'latest answer']);
});

test('上下文裁剪保留最新完整工具调用与工具结果', () => {
  const toolRound = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call-1', name: 'lookup', content: 'result' },
    { role: 'assistant', content: 'done' },
  ];
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'old '.repeat(300) },
    { role: 'assistant', content: 'old answer '.repeat(300) },
    { role: 'user', content: 'latest' },
    ...toolRound,
  ];
  const limited = limitAiControlMessages(messages, 100);
  assert.equal(limited.some((message) => message.tool_call_id === 'call-1'), true);
  assert.equal(limited.some((message) => message.tool_calls?.[0]?.id === 'call-1'), true);
  assert.equal(limited[0].role, 'system');
});

test('上下文裁剪不破坏超限的最新轮次或图片输入', () => {
  assert.throws(() => limitAiControlMessages([
    { role: 'system', content: 'system' },
    { role: 'user', content: 'latest '.repeat(100) },
  ], 20), { code: 'AI_CONTEXT_WINDOW_LIMIT' });
  assert.throws(() => limitAiControlMessages([
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://image.example/a.png' } }] },
  ], 512), { code: 'AI_CONTEXT_WINDOW_LIMIT' });
});

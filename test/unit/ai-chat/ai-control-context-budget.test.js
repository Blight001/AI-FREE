'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  fitAiControlContext,
  serializedLength,
} = require('../../../src/app/backend/lib/ai-control-context-budget');

test('上下文预算保留系统消息、最近对话和完整工具配对', () => {
  const largeResult = JSON.stringify({ items: '结果'.repeat(10000) });
  const messages = [
    { role: 'system', content: '工具规则' },
    ...Array.from({ length: 18 }, (_, index) => [
      { role: 'user', content: `旧问题-${index}-${'内容'.repeat(500)}` },
      { role: 'assistant', content: `旧回答-${index}-${'结论'.repeat(500)}` },
    ]).flat(),
    {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'call-1', function: { name: 'browser_observe', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call-1', name: 'browser_observe', content: largeResult },
    { role: 'user', content: '根据刚才的结果继续' },
  ];
  const original = structuredClone(messages);
  const tools = [{ name: 'browser_observe', input_schema: { type: 'object' } }];
  const fitted = fitAiControlContext(messages, tools, { maxRequestChars: 18000, toolResultChars: 4000 });

  assert.ok(serializedLength(fitted, tools) <= 18000);
  assert.equal(fitted[0].role, 'system');
  assert.match(fitted[1].content, /较早对话摘要/);
  assert.equal(fitted.at(-1).content, '根据刚才的结果继续');
  const assistant = fitted.find((message) => message.tool_calls?.[0]?.id === 'call-1');
  const tool = fitted.find((message) => message.tool_call_id === 'call-1');
  assert.ok(assistant);
  assert.ok(tool);
  assert.ok(JSON.parse(tool.content)._context_omitted);
  assert.deepEqual(messages, original, '发送副本的压缩不应破坏持久化历史');
});

test('未超预算时不改写普通对话', () => {
  const messages = [
    { role: 'system', content: '规则' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好，有什么可以帮你？' },
  ];
  assert.deepEqual(fitAiControlContext(messages, []), messages);
});

test('模型请求不重复携带仅用于 UI 重建的思考和工具时间线', () => {
  const fitted = fitAiControlContext([{
    role: 'assistant',
    content: '最终答案',
    reasoning: '内部思考',
    tool_events: [{ id: 'tool-1', result: '大量展示数据' }],
    trace_events: [{ type: 'reasoning', content: '内部思考' }],
  }], []);

  assert.deepEqual(fitted, [{ role: 'assistant', content: '最终答案' }]);
});

function toolRound(name, result, args = {}, imageChars = 0) {
  return [
    { role: 'assistant', content: '', tool_calls: [{ id: name, function: { name, arguments: JSON.stringify(args) } }] },
    { role: 'tool', name, tool_call_id: name, content: JSON.stringify(result) },
    ...(imageChars ? [{
      role: 'user', ai_free_transient_image: true, ai_free_tool_call_id: name,
      content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(imageChars)}` } }],
    }] : []),
  ];
}

test('大观察和工具截图不会挤掉画圆的目标、标签、接管与定位证据', () => {
  const goal = { role: 'user', content: '调用鼠标在这个画布上画一个圆' };
  const circle = { id: 'e-circle', selector: '#btnCircle', role: 'button', label: '圆形', clickX: 145, clickY: 34 };
  const items = Array.from({ length: 42 }, (_, i) => ({
    id: `e-${i}`, selector: `#button${i}`, role: 'button', text: '附加页面描述'.repeat(75),
    ancestors: [{ text: '工具栏介绍'.repeat(70) }], clickX: i * 10, clickY: 34,
  }));
  items[21] = { ...items[21], ...circle };
  const observation = { success: true, observationId: 'obs-1', viewport: { width: 850, height: 590 },
    coordinateSpace: 'viewport', returnedCount: items.length, items, image_attached: true };
  const messages = [goal,
    ...toolRound('browser_tab', { success: true, activeTabId: 2 }, { action: 'list' }),
    ...toolRound('browser_control', { success: true, acquired: true }, { action: 'acquire' }),
    ...toolRound('browser_observe', observation, { include_screenshot: true }, 110000),
  ];
  const original = structuredClone(messages);
  const fitted = fitAiControlContext(messages);
  assert.deepEqual(fitted[0], goal);
  assert.deepEqual(fitted.filter((m) => m.role === 'tool').map((m) => m.tool_call_id),
    ['browser_tab', 'browser_control', 'browser_observe']);
  const result = JSON.parse(fitted.at(-1).content);
  assert.equal(result.observationId, 'obs-1');
  assert.deepEqual(result.viewport, observation.viewport);
  assert.equal(result.coordinateSpace, 'viewport');
  assert.ok(result._context_omitted);
  assert.equal(result.image_attached, false);
  assert.equal(result.image_omitted_reason, 'context_budget');
  const target = result.items.find((item) => item.id === circle.id);
  for (const [key, value] of Object.entries(circle)) assert.equal(target[key], value);
  assert.deepEqual(messages, original);
});

test('嵌套观察按模型窗口裁剪且保留失败和观察身份', () => {
  const goal = { role: 'user', content: '继续' };
  const items = [{ ref: 'round', selector: '#btnCircle', clickX: 31, clickY: 24 }];
  const messages = [goal, ...toolRound('browser_action', {
    success: false, errorCode: 'VERIFY_FAILED', retryable: false, log: 'x'.repeat(60000),
    observation: { observationId: 'after-1', viewport: { width: 850, height: 590 },
      image_attached: true, pageText: 'x'.repeat(40000), items }, image_attached: true,
  }, { after: 'observe' }, 14000)];
  const fitted = fitAiControlContext(messages, [], { contextWindow: 800 });
  assert.equal(fitted.length, 3);
  const result = JSON.parse(fitted.at(-1).content);
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'VERIFY_FAILED');
  assert.equal(result.retryable, false);
  assert.equal(result.observation.observationId, 'after-1');
  assert.deepEqual(result.observation.items, items);
  assert.equal(result.observation.image_attached, false);
  assert.throws(() => fitAiControlContext(messages, [], { contextWindow: 5 }), { code: 'AI_CONTEXT_WINDOW_LIMIT' });
});

test('保留用户主动附加的大图，并单独限制工具图像', () => {
  const goal = { role: 'user', content: '参照附件在画布上画圆' };
  const attachment = { role: 'user', ai_free_attachment_context: true, content: [
    { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(256000)}` } },
  ] };
  const messages = [goal, attachment,
    ...toolRound('browser_screenshot', { success: true, image_attached: true }, {}, 110000),
  ];
  const fitted = fitAiControlContext(messages);
  assert.deepEqual(fitted.slice(0, 2), [goal, attachment]);
  assert.equal(fitted.length, 4);
  assert.equal(JSON.parse(fitted.at(-1).content).image_omitted_reason, 'context_budget');
  assert.throws(() => fitAiControlContext(messages, [], { contextWindow: 800 }), { code: 'AI_CONTEXT_WINDOW_LIMIT' });
});

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { runChatConversation } = require('../../../src/app/backend/features/ai-chat/chat-conversation-runner');
const { buildChatToolContext } = require('../../../src/app/backend/features/ai-chat/chat-tool-context');
const { syncWindowToolControl } = require('../../../src/app/backend/features/ai-chat/chat-tool-executor');
const { NATIVE_BROWSER_TOOL_DEFINITIONS } = require('../../../src/app/backend/services/native-browser-tool-definitions');

const toolName = 'browser_page_batch';
const action = (name, args) => ({ tool: 'browser_action', arguments: { action: name, ...args } });
const steps = [
  action('click', { selector: '#open' }),
  { tool: 'browser_wait', arguments: { selector: '#draft', condition: 'visible' } },
  action('click', { selector: '#draft' }),
  action('type', { selector: '#draft', text: 'First draft' }),
  action('press_key', { key: 'End' }),
  action('insert_text', { text: '!' }),
  action('scroll', { direction: 'down', amount: 64 }),
  action('drag', { x: 20, y: 40, to_x: 50, to_y: 44 }),
  action('set_checked', { selector: '#preview', checked: true }),
  { tool: 'browser_wait', arguments: { selector: '#status', condition: 'text_contains', value: 'Preview' } },
];
const pageToken = 'initial-document';
const connection = { id: 'native:editor', name: 'Editor', tools: NATIVE_BROWSER_TOOL_DEFINITIONS.filter(
  ({ name }) => ['browser_action', 'browser_wait', 'browser_workflow'].includes(name),
) };

async function runBatch({ input = { steps }, onStep = () => ({ success: true }), otherCalls = [] } = {}) {
  const controller = new AbortController();
  const insertedMessages = [];
  const order = [];
  const actions = [];
  let batchResult;
  const toolContext = buildChatToolContext({ localInteraction: true, connections: [connection],
    initialMessages: [{ role: 'user', content: 'Prepare the draft and preview it' }],
  });
  const result = await runChatConversation({
    localInteraction: true, connections: [connection], toolContext,
    run: { controller, insertedMessages }, emit() {},
    bridge: {
      getConnection: () => connection,
      async dispatch(id, name, args, options) {
        assert.equal(id, connection.id);
        if (name === 'browser_tab') return { activeTab: { url: 'http://editor.test/', pageToken } };
        order.push(name);
        actions.push({ args, options });
        return onStep(actions.length, controller, options, insertedMessages);
      },
    },
    httpClient: {
      async sendAIControlMessage(_key, _device, _model, messages) {
        order.push('model');
        if (order.length === 1) return { ok: true, message: { tool_calls: [{ id: 'batch',
          function: { name: toolName, arguments: JSON.stringify(input) },
        }, ...otherCalls] } };
        const toolMessage = messages.find((message) => message.role === 'tool' && message.tool_call_id === 'batch');
        batchResult = JSON.parse(toolMessage.content);
        return { ok: true, message: { content: messages.at(-1)?.role === 'user' ? messages.at(-1).content : 'Finished' } };
      },
    },
  });
  return { toolContext, result, batchResult, order, actions };
}

test('one advertised call runs ten mixed page steps in order without returning to the model', async () => {
  const { toolContext, result, batchResult, order, actions } = await runBatch();
  assert.ok(toolContext.tools.some((tool) => tool.name === toolName));
  assert.ok(!toolContext.tools.some((tool) => tool.name === 'browser_workflow'));
  assert.equal(result.message.content, 'Finished');
  assert.deepEqual(order, ['model', ...steps.map(({ tool }) => tool), 'model']);
  assert.deepEqual(actions.map(({ args }) => args), steps.map((step) => step.arguments));
  assert.ok(actions.every(({ options }) => options.expectedPageToken === pageToken && options.allowAppSurface === false));
  assert.deepEqual(batchResult, { success: true, requested: 10, completed: 10, notAttempted: 0 });
});

test('a same-URL refresh refuses the fourth step and skips the remainder', async () => {
  let activeToken = pageToken;
  const { batchResult, actions } = await runBatch({ onStep(index, _controller, options) {
    if (index === 4) activeToken = 'new-document';
    return options.expectedPageToken === activeToken ? { success: true } : {
      success: false, errorCode: 'BROWSER_TARGET_CHANGED', actionExecuted: false,
    };
  } });
  assert.equal(actions.length, 4);
  assert.equal(batchResult.errorCode, 'BROWSER_TARGET_CHANGED');
  assert.equal(batchResult.completed, 3);
  assert.equal(batchResult.failedStep, 4);
  assert.equal(batchResult.failedStepOutcome, 'not_executed');
  assert.equal(batchResult.notAttempted, 6);
});

test('a lost response stops the batch and subsequent same-round calls without replay', async () => {
  const sibling = { id: 'sibling', function: { name: 'browser_action', arguments: '{"action":"click","selector":"#submit"}' } };
  const { batchResult, actions, result } = await runBatch({ otherCalls: [sibling], onStep(index) {
    if (index === 3) throw new Error('Connection lost after input');
    return { success: true };
  } });
  assert.equal(actions.length, 3);
  assert.equal(batchResult.completed, 2);
  assert.equal(batchResult.failedStep, 3);
  assert.equal(batchResult.failedStepOutcome, 'unknown');
  assert.equal(batchResult.notAttempted, 7);
  assert.equal(batchResult.recoverable, false);
  assert.equal(result.messages.filter((message) => message.role === 'tool').length, 2);
  assert.equal(JSON.parse(result.messages.find((message) => message.tool_call_id === 'sibling').content).actionExecuted, false);
});

test('stop immediately ends the batch while a step is in flight', async () => {
  let finishStep;
  const { result, order } = await runBatch({ onStep(index, controller) {
    if (index === 3) return new Promise((resolve) => {
      finishStep = resolve;
      setImmediate(() => controller.abort());
    });
    return { success: true };
  } });
  assert.equal(result.stopped, true);
  const activity = result.message.tool_events[0];
  assert.equal(activity.result.completed, 2);
  assert.equal(activity.result.failedStepOutcome, 'unknown');
  assert.equal(activity.result.notAttempted, 7);
  finishStep({ success: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['model', ...steps.slice(0, 3).map(({ tool }) => tool)]);
});

test('an inserted user instruction ends the old plan at the next step boundary', async () => {
  const { result, batchResult, actions } = await runBatch({ onStep(index, _controller, _options, insertedMessages) {
    if (index === 3) insertedMessages.push({ role: 'user', content: 'Inspect only; do not edit.' });
    return { success: true };
  } });
  assert.equal(actions.length, 3);
  assert.equal(batchResult.errorCode, 'BROWSER_PAGE_BATCH_USER_INPUT');
  assert.equal(batchResult.completed, 3);
  assert.equal(batchResult.notAttempted, 7);
  assert.equal(result.message.content, 'Inspect only; do not edit.');
});

test('unsupported nested routing and features reject the entire plan before any input', async () => {
  const invalidSteps = [
    action('upload_file', {}), action('click', { change_browser: 'other' }),
    action('click', { surface: 'shell' }), action('click', { after: 'observe' }),
    action('click', { selector: '#x', expectedPageToken: 'spoofed' }),
    action('click', { selector: '#x', expect: [] }),
    action('click', { locator: { role: 'button', name: 'Preview' } }),
    action('set_checked', { selector: '#preview', checked: 'true' }),
    { tool: 'browser_wait', arguments: { ref: 'ref-without-a-selector', condition: 'visible' } },
    { tool: 'browser_file', arguments: { action: 'upload' } },
    { tool: 'browser_tab', arguments: { action: 'navigate' } },
    { tool: toolName, arguments: { steps } },
  ];
  for (const invalid of invalidSteps) {
    const { batchResult, actions } = await runBatch({ input: { steps: [...steps.slice(0, 9), invalid] } });
    assert.equal(batchResult.errorCode, 'BROWSER_PAGE_BATCH_INVALID');
    assert.equal(batchResult.invalidStep, 10);
    assert.equal(actions.length, 0);
  }
});

test('opening a browser during a sidebar turn adds the batch tool, not the nested workflow', () => {
  const context = {
    localInteraction: true, browserControl: { connectionId: '' }, connections: [], toolDefinitions: [],
    bridge: { getConnection: () => connection }, emit() {},
  };
  const ready = { success: true, control_browser_id: connection.id };
  syncWindowToolControl(context, 'windows_tab', { action: 'open' }, ready);
  syncWindowToolControl(context, 'windows_tab', { action: 'open' }, ready);
  assert.deepEqual(context.toolDefinitions.map(({ name }) => name), ['browser_action', 'browser_wait', toolName]);
  const external = buildChatToolContext({ connections: [connection], initialMessages: [] });
  assert.deepEqual(external.tools.map(({ name }) => name), connection.tools.map(({ name }) => name));
});

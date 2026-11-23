'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createNativeAutomationCardService } = require('../../../src/app/backend/services/native-automation-card-service');

function fixture() {
  let state = { items: [], selectedId: '' };
  const service = createNativeAutomationCardService({
    read: () => ({ exists: true, state: structuredClone(state) }),
    write: (next) => { state = structuredClone(next); return state; },
  });
  return { service, state: () => state };
}

test('native card management persists validated cards and supports local step edits', async () => {
  const { service, state } = fixture();
  const written = await service.execute({
    action: 'write',
    cardData: { name: '登录', website: 'https://example.com', steps: [{ type: 'click', selector: '#login' }] },
  });
  await service.execute({
    action: 'insert_step', id: written.item.id, step_index: 2,
    stepData: { type: 'wait', selector: '#ready' },
  });
  assert.equal(state().items[0].cardData.steps.length, 2);
  const listed = await service.execute({ action: 'list' });
  assert.equal(listed.items[0].name, '登录');
  assert.equal(listed.items[0].website, 'https://example.com');
  assert.equal(listed.items[0].stepCount, 2);
  await assert.rejects(() => service.execute({ action: 'get' }), /未指定/);
});

test('native card run opens the website and executes page steps through native tool dispatch', async () => {
  const { service } = fixture();
  const written = await service.execute({
    action: 'write',
    cardData: {
      name: '填写', website: 'https://example.com/form',
      steps: [{ type: 'type', selector: '#email', variable: 'email', text: 'default@example.com' }],
    },
  });
  const calls = [];
  const result = await service.execute({ action: 'run', id: written.item.id, inputs: { email: 'user@example.com' } }, {
    dispatch: async (tool, args) => { calls.push([tool, args]); return { success: true }; },
  });
  assert.equal(result.success, true);
  assert.deepEqual(calls, [
    ['browser_tab', { action: 'list' }],
    ['browser_tab', { action: 'replace', url: 'https://example.com/form' }],
    ['browser_action', { type: 'type', selector: '#email', variable: 'email', text: 'user@example.com', action: 'type' }],
  ]);
});

test('native card validation rejects script conditions before persistence', async () => {
  const { service } = fixture();
  await assert.rejects(() => service.execute({
    action: 'write',
    cardData: {
      name: 'unsafe', website: 'https://example.com',
      steps: [{ type: 'condition', condition_mode: 'js', script: 'return true' }],
    },
  }), /禁止 JavaScript 条件/);
});

test('native card can invoke an existing MCP tool with nested input substitution', async () => {
  const { service } = fixture();
  const written = await service.execute({
    action: 'write',
    cardData: {
      name: '调用已有 MCP',
      steps: [{
        type: 'mcp', tool: 'run_command',
        arguments: { command: 'echo {message}', metadata: { label: '{message}' } },
      }],
    },
  });
  const calls = [];
  const result = await service.execute({
    action: 'run', id: written.item.id, inputs: { message: 'hello' },
  }, {
    dispatch: async (tool, args) => { calls.push([tool, args]); return { success: true }; },
  });

  assert.equal(result.success, true);
  assert.deepEqual(calls, [[
    'run_command',
    { command: 'echo hello', metadata: { label: 'hello' } },
  ]]);
});

test('card input schemas reject invalid inputs before dispatching the first step', async () => {
  const { service } = fixture();
  let dispatched = 0;
  const written = await service.execute({
    action: 'write',
    inputSchema: {
      type: 'object', required: ['target'], additionalProperties: false,
      properties: { target: { type: 'string', enum: ['draft', 'publish'] } },
    },
    cardData: { name: 'Schema guarded', steps: [{ type: 'mcp', tool: 'test_action' }] },
  });
  const run = (inputs) => service.execute({ action: 'run', id: written.item.id, inputs }, {
    dispatch: async () => { dispatched += 1; return { success: true }; },
  });

  await assert.rejects(run({}), /缺少必填输入: inputs.target/);
  await assert.rejects(run({ target: 'unknown' }), /不在允许值范围内/);
  await assert.rejects(run({ target: 'draft', extra: true }), /不支持的输入字段/);
  assert.equal(dispatched, 0);
  const completed = await run({ target: 'publish' });
  assert.equal(completed.success, true);
  assert.equal(dispatched, 1);
});

test('native card run results redact password-shaped and writeOnly inputs', async () => {
  const { service } = fixture();
  const password = 'card-password-6842';
  const hiddenValue = 'private-value-1947';
  const written = await service.execute({
    action: 'write',
    inputSchema: { type: 'object', properties: {
      password: { type: 'string' }, accessPhrase: { type: 'string', writeOnly: true },
    } },
    cardData: { name: 'Redacted result', steps: [{
      type: 'mcp', tool: 'echo', arguments: { text: '{password} {accessPhrase}' },
    }] },
  });
  const result = await service.execute({
    action: 'run', id: written.item.id, inputs: { password, accessPhrase: hiddenValue },
  }, {
    inputSchema: written.item.inputSchema,
    dispatch: async (_tool, args) => ({ success: true, echo: args.text }),
  });

  assert.equal(result.success, true);
  assert.equal(JSON.stringify(result).includes(password), false);
  assert.equal(JSON.stringify(result).includes(hiddenValue), false);
  assert.equal(result.context.password, '[REDACTED]');
  assert.equal(result.execution[0].result.echo, '[REDACTED] [REDACTED]');
});

test('native card rejects an MCP step without an object argument payload', async () => {
  const { service } = fixture();
  await assert.rejects(() => service.execute({
    action: 'write',
    cardData: { name: 'invalid', steps: [{ type: 'mcp', tool: 'run_command', arguments: [] }] },
  }), /arguments 必须是对象/);
});

test('native card stops when a native tool returns a structured failure', async () => {
  const { service } = fixture();
  const written = await service.execute({
    action: 'write',
    cardData: {
      name: '点击失败即停止', website: 'https://example.com',
      steps: [
        { name: '点击发布', type: 'click', selector: '#publish' },
        { name: '不应继续', type: 'wait', timeout: 1000 },
      ],
    },
  });
  const calls = [];
  const result = await service.execute({ action: 'run', id: written.item.id }, {
    dispatch: async (tool, args) => {
      calls.push([tool, args]);
      if (tool === 'browser_action') {
        return { success: false, error: '未找到发布按钮', errorCode: 'ELEMENT_NOT_FOUND' };
      }
      return { success: true };
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'ELEMENT_NOT_FOUND');
  assert.equal(result.stepIndex, 1);
  assert.equal(result.execution.length, 2);
  assert.equal(calls.some(([tool]) => tool === 'browser_wait'), false);
});

test('required condition fails the card and does not execute later steps', async () => {
  const { service } = fixture();
  const written = await service.execute({
    action: 'write',
    cardData: {
      name: '发布确认', website: 'https://example.com/publish',
      steps: [
        {
          id: 'check_published', name: '确认发布成功', type: 'condition',
          condition_mode: 'url_matches', text: 'published=true', fail_on_false: true,
        },
        { id: 'after_success', name: '成功后步骤', type: 'screenshot' },
      ],
      flow: {
        start: 'check_published',
        nodes: [{ id: 'check_published' }, { id: 'after_success' }],
        edges: [{ from: 'check_published', to: 'after_success', label: 'true' }],
      },
    },
  });
  const calls = [];
  const result = await service.execute({ action: 'run', id: written.item.id }, {
    dispatch: async (tool) => {
      calls.push(tool);
      if (tool === 'browser_tab') {
        return { success: true, activeTab: { url: 'https://example.com/publish' } };
      }
      return { success: true };
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'CARD_CONDITION_FAILED');
  assert.equal(result.stepIndex, 1);
  assert.deepEqual(calls, ['browser_tab', 'browser_tab']);
});

test('flow node without an outgoing edge is terminal instead of falling through step order', async () => {
  const { service } = fixture();
  const written = await service.execute({
    action: 'write',
    cardData: {
      name: '失败分支终止', website: 'https://example.com/publish',
      steps: [
        { id: 'check', type: 'condition', condition_mode: 'url_matches', text: 'published=true' },
        { id: 'success', type: 'screenshot' },
        { id: 'failure', type: 'screenshot' },
        { id: 'must_not_run', type: 'save_cookies' },
      ],
      flow: {
        start: 'check',
        nodes: [{ id: 'check' }, { id: 'success' }, { id: 'failure' }, { id: 'must_not_run' }],
        edges: [
          { from: 'check', to: 'success', label: 'true' },
          { from: 'check', to: 'failure', label: 'false' },
        ],
      },
    },
  });
  const calls = [];
  const result = await service.execute({ action: 'run', id: written.item.id }, {
    dispatch: async (tool) => {
      calls.push(tool);
      if (tool === 'browser_tab') {
        return { success: true, activeTab: { url: 'https://example.com/publish' } };
      }
      return { success: true };
    },
  });

  assert.equal(result.success, true);
  assert.deepEqual(calls, ['browser_tab', 'browser_tab', 'browser_screenshot']);
});

test('flow back-edges execute bounded loops and stop at the configured transition limit', async () => {
  const { service } = fixture();
  const written = await service.execute({
    action: 'write',
    limits: { timeoutSeconds: 30, maxTransitions: 4 },
    cardData: {
      name: '有限循环',
      steps: [{ id: 'tick', type: 'delay', delayMs: 0 }, { id: 'finish', type: 'end' }],
      flow: { start: 'tick', edges: [{ from: 'tick', to: 'tick', label: 'next' }] },
    },
  });

  await assert.rejects(service.execute({ action: 'run', id: written.item.id }, {
    maxTransitions: 4,
    dispatch: async () => ({ success: true }),
  }), /超过安全步数限制/);
});

test('card metadata and immutable versions survive updates, validation, cloning and export', async () => {
  const { service } = fixture();
  const first = await service.execute({
    action: 'write', status: 'draft', riskLevel: 'high_risk', tags: ['publish'], accessScope: 'owner',
    inputSchema: { type: 'object', required: ['title'] }, limits: { timeoutSeconds: 30, maxTransitions: 8 },
    cardData: { name: '发布', description: 'first', steps: [{ type: 'end' }] },
  });
  const second = await service.execute({
    action: 'write', id: first.item.id,
    cardData: { name: '发布', description: 'second', steps: [{ type: 'delay', delayMs: 1 }, { type: 'end' }] },
  });
  assert.equal(second.item.versions.length, 2);
  assert.equal(second.item.versions[0].cardData.description, 'first');
  assert.equal(second.item.riskLevel, 'high_risk');
  assert.deepEqual(second.item.inputSchema.required, ['title']);
  const validated = await service.execute({ action: 'validate', id: second.item.id });
  assert.equal(validated.digest.length, 64);
  const versions = await service.execute({ action: 'versions', id: second.item.id });
  assert.equal(versions.items[0].digest === versions.items[1].digest, false);
  const unchanged = await service.execute({ action: 'write', id: second.item.id, cardData: second.item.cardData });
  assert.equal(unchanged.item.versions.length, 2);
  const cloned = await service.execute({ action: 'clone', id: second.item.id, name: '发布副本' });
  assert.equal(cloned.item.cardName, '发布副本');
  assert.notEqual(cloned.item.id, second.item.id);
  const exported = await service.execute({ action: 'export', id: second.item.id });
  assert.equal(exported.card.latestVersionId, second.item.latestVersionId);
});

test('soft-deleted cards stay hidden by default and can be restored or permanently removed', async () => {
  const { service, state } = fixture();
  const written = await service.execute({
    action: 'write', cardData: { name: 'Trash me', steps: [{ type: 'end' }] },
  });
  await service.execute({ action: 'delete', id: written.item.id });
  assert.equal((await service.execute({ action: 'list' })).items.length, 0);
  assert.equal((await service.execute({ action: 'list', include_deleted: true })).items.length, 1);
  await assert.rejects(service.execute({ action: 'get', id: written.item.id }));
  await service.execute({ action: 'restore', id: written.item.id });
  assert.equal((await service.execute({ action: 'get', id: written.item.id })).item.deletedAt, null);
  await service.execute({ action: 'delete', id: written.item.id });
  const purged = await service.execute({ action: 'purge', id: written.item.id });
  assert.equal(purged.permanent, true);
  assert.equal(state().items.length, 0);
});

test('delay and end steps support progress, retries and cooperative cancellation', async () => {
  const { service } = fixture();
  const written = await service.execute({
    action: 'write',
    cardData: {
      name: '可恢复流程',
      steps: [
        { id: 'retry', type: 'mcp', tool: 'unstable', retryPolicy: { maxAttempts: 2, delaySeconds: 0 } },
        { id: 'pause', type: 'delay', delayMs: 1 },
        { id: 'done', type: 'end' },
        { id: 'never', type: 'mcp', tool: 'must_not_run' },
      ],
    },
  });
  let attempts = 0;
  const progress = [];
  const result = await service.execute({ action: 'run', id: written.item.id }, {
    onProgress: (item) => progress.push(item),
    dispatch: async () => {
      attempts += 1;
      if (attempts === 1) return { success: false, error: 'temporary', retryable: true, actionExecuted: false };
      return { success: true };
    },
  });
  assert.equal(result.success, true);
  assert.equal(attempts, 2);
  assert.equal(result.execution.at(-1).type, 'end');
  assert.equal(progress.some((item) => item.stepId === 'retry' && item.attempt === 2), true);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.execute({ action: 'run', id: written.item.id }, {
    signal: controller.signal, dispatch: async () => ({ success: true }),
  }), (error) => error.errorCode === 'RUN_CANCELLED');
});

test('schema-only revisions keep their input contract across store round trips', async () => {
  const { normalizeCardEntry } = require('../../../src/app/backend/services/automation-card-store');
  const { service } = fixture();
  const cardData = { name: 'typed revision', steps: [{ type: 'mcp', tool: 'echo', arguments: { n: '{n}' } }] };
  const inputSchema = (type) => ({ type: 'object', required: ['n'], properties: { n: { type } } });
  const first = (await service.execute({ action: 'write', cardData, inputSchema: inputSchema('integer') })).item;
  const second = (await service.execute({ action: 'write', id: first.id, cardData, inputSchema: inputSchema('boolean') })).item;
  assert.notEqual(first.latestVersionId, second.latestVersionId);
  assert.deepEqual(normalizeCardEntry(second).versions.map((v) => v.inputSchema), [inputSchema('integer'), inputSchema('boolean')]);
  const values = [];
  const run = (version_id, n) => service.execute({ action: 'run', id: first.id, version_id, inputs: { n } }, {
    dispatch: async (_name, args) => { values.push(args.n); return { success: true }; },
  });
  await assert.rejects(run(first.latestVersionId, true), /类型错误/);
  await run(first.latestVersionId, 2);
  await run(second.latestVersionId, false);
  assert.deepEqual(values, [2, false]);
});

test('unknown dispatch outcome stops a card with a retry policy after one attempt', async () => {
  const { service } = fixture();
  const { item } = await service.execute({ action: 'write', cardData: { name: 'unknown outcome', steps: [
    { type: 'mcp', tool: 'submit', retryPolicy: { maxAttempts: 2 } },
  ] } });
  let dispatched = 0;
  const result = await service.execute({ action: 'run', id: item.id }, { dispatch: async () => {
    dispatched += 1;
    throw new Error('connection closed');
  } });
  assert.equal(result.success, false);
  assert.equal(result.retryable, false);
  assert.equal(dispatched, 1);
});

test('a refused website opening stops before the first action and reports the navigation failure', async () => {
  const { service } = fixture();
  const { item } = await service.execute({ action: 'write', cardData: { name: 'website opening',
    website: 'https://example.test/form', steps: [{ type: 'click', selector: '#confirm' }] } });
  const calls = [];
  const result = await service.execute({ action: 'run', id: item.id }, { dispatch: async (_tool, args) => {
    calls.push(args.action);
    if (args.action === 'list') return { success: true, activeTab: { url: 'about:blank' } };
    return { ok: false, error: 'navigation refused', errorCode: 'NAVIGATION_DENIED' };
  } });
  assert.deepEqual(calls, ['list', 'replace']);
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'NAVIGATION_DENIED');
  assert.equal(result.execution[0].success, false);
});

test('a retry hint cannot override an uncertain action result', async () => {
  const { service } = fixture();
  const { item } = await service.execute({ action: 'write', cardData: { name: 'uncertain result',
    steps: [{ type: 'mcp', tool: 'submit', retryPolicy: { maxAttempts: 2 } }] } });
  let attempts = 0;
  const result = await service.execute({ action: 'run', id: item.id }, { dispatch: async () => {
    attempts += 1;
    return { success: false, retryable: true, actionExecuted: 'unknown' };
  } });
  assert.equal(attempts, 1);
  assert.equal(result.retryable, false);
  assert.equal(result.sideEffectsMayHaveOccurred, true);
});

test('implicit entry keeps the active matching document and navigates different routes', async () => {
  const { service } = fixture();
  const website = 'https://example.test/home?view=login#form';
  const { item } = await service.execute({ action: 'write', cardData: { name: 'login fixture', website,
    steps: [{ type: 'click', selector: '#open' }] } });
  for (const url of [website, website.replace('login', 'guest'), website.replace('#form', '#account'), 'https://other.test/home']) {
    const actions = [];
    const result = await service.execute({ action: 'run', id: item.id }, { dispatch: async (_, args) => {
      actions.push(args.action);
      return args.action === 'list' ? { success: true, activeTab: { url } } : { success: true };
    } });
    assert.equal(result.success, true);
    assert.deepEqual(actions, url === website ? ['list', 'click'] : ['list', 'replace', 'click']);
  }
});

test('a document inspection error cannot satisfy a missing-text login condition', async () => {
  const { service } = fixture();
  const { item } = await service.execute({ action: 'write', cardData: { name: 'postcondition', steps: [
    { type: 'delay', delayMs: 0 }, { type: 'condition', condition: 'text_missing', text: 'Guest', fail_on_false: true },
    { type: 'click', selector: '#account' },
  ] } });
  const calls = [];
  const result = await service.execute({ action: 'run', id: item.id }, { dispatch: async (tool) => {
    calls.push(tool); return { success: false, errorCode: 'BROWSER_TARGET_CHANGED', error: 'Page changed' };
  } });
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'BROWSER_TARGET_CHANGED');
  assert.equal(result.stepIndex, 2);
  assert.equal(calls.length, 1);
});

test('a positive selector assertion checks the specified login marker, not unrelated controls', async () => {
  const { service } = fixture();
  const { item } = await service.execute({ action: 'write', cardData: { name: 'account visible', steps: [
    { type: 'delay', delayMs: 0 }, { type: 'condition', condition: 'selector_exists', selector: '#account', fail_on_false: true },
  ] } });
  for (const present of [false, true]) {
    const result = await service.execute({ action: 'run', id: item.id }, { dispatch: async (tool, args) => {
      if (tool === 'browser_observe') return { success: true, items: [{ selector: '#unrelated' }] };
      assert.equal(args.selector, '#account');
      return present ? { success: true, condition: 'attached' }
        : { success: false, errorCode: 'WAIT_TIMEOUT', condition: 'attached' };
    } });
    assert.equal(result.success, present);
    if (!present) assert.equal(result.errorCode, 'CARD_CONDITION_FAILED');
  }
});

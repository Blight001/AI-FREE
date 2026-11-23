'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createNativeAutomationCardService } = require('../../../src/app/backend/services/native-automation-card-service');

async function fixture(steps) {
  let state = { items: [], selectedId: '' };
  let writes = 0;
  const service = createNativeAutomationCardService({
    read: () => ({ state: structuredClone(state) }),
    write: (next) => { state = structuredClone(next); writes += 1; },
  });
  const { item } = await service.execute({ action: 'write', cardData: { name: 'Step edit', website: 'https://example.test', steps } });
  return {
    patch: (step_index, stepPatch, options = {}) => service.execute({ action: 'patch_step', id: item.id, step_index, stepPatch, ...options }),
    get: async () => (await service.execute({ action: 'get', id: item.id })).item,
    writes: () => writes,
  };
}

const waitArgs = { condition: 'visible', selector: '#ready' };
const click = { type: 'click', selector: '#submit' };
const wait = { type: 'wait', selector: '#pending' };
const account = { type: 'mcp', tool: 'account_manage', arguments: { action: 'categories' } };

for (const [step, field, value] of [
  [click, 'arguments', { ms: 200 }], [click, 'arguments', waitArgs],
  [wait, 'arguments', waitArgs], [wait, 'args', { ms: 200 }], [click, 'args', waitArgs],
]) {
  test(`patch_step rejects ${field} on native ${step.type} (${Object.keys(value)}) without writing`, async () => {
    const card = await fixture([account, step]);
    const before = await card.get();
    await assert.rejects(card.patch(2, { [field]: value }), /顶层/);
    assert.equal(card.writes(), 1);
    assert.deepEqual(await card.get(), before);
  });
}

test('patch_step requires an existing 1-based step index even for a full replacement', async () => {
  const card = await fixture([click, wait]);
  const before = await card.get();
  for (const index of [0, -1, 1.5, 3, undefined, 'abc']) {
    await assert.rejects(card.patch(index, { type: 'end' }, { replace: true }), /step_index/);
  }
  assert.equal(card.writes(), 1);
  assert.deepEqual(await card.get(), before);
});

test('a top-level patch edits only the numbered step and preserves legacy native fields', async () => {
  const legacyClick = { ...click, arguments: { ms: 200 } };
  const card = await fixture([account, legacyClick, wait]);
  await card.patch('2', { selector: '#confirm' });
  await card.patch(3, { selector: '#ready', timeout: 200 });
  assert.deepEqual((await card.get()).cardData.steps, [
    account, { ...legacyClick, selector: '#confirm' }, { ...wait, selector: '#ready', timeout: 200 },
  ]);
});

test('changing step types checks the resulting type and allows MCP tools and placeholders', async () => {
  const card = await fixture([click, account]);
  const extension = { type: 'mcp', tool: 'extension_tool', arguments: { custom: '{value}' } };
  await card.patch(1, extension, { replace: true });
  await card.patch(1, { arguments: { nested: { arbitrary: '{input}' } } });
  await assert.rejects(card.patch(2, { ...wait, args: waitArgs }, { replace: true }), /顶层/);
  await card.patch(2, wait, { replace: true });
  assert.deepEqual((await card.get()).cardData.steps, [
    { ...extension, arguments: { nested: { arbitrary: '{input}' } } }, wait,
  ]);
});

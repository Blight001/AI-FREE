'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const viewModel = require('../../../src/app/renderer/controllers/pages/app-shell/automation-workbench-view-model');

test('normalizes legacy and workflow cards without losing metadata', () => {
  const legacy = viewModel.normalizeCard({
    id: 'legacy', cardName: '旧卡片', cardData: { steps: [{}, {}], enabled: false, tags: ['browser'] },
  });
  assert.equal(legacy.name, '旧卡片');
  assert.equal(legacy.status, 'disabled');
  assert.equal(legacy.stepCount, 2);
  assert.deepEqual(legacy.tags, ['browser']);

  const workflow = viewModel.normalizeCard({
    id: 'flow', name: '流程', status: 'published', risk_level: 'write',
    definition: { steps: { one: {}, two: {} } },
  });
  assert.equal(workflow.stepCount, 2);
  assert.equal(workflow.riskLevel, 'write');
});

test('filters cards by status and searchable metadata', () => {
  const cards = [
    { id: 'one', name: '日报', status: 'active', tags: ['办公'] },
    { id: 'two', name: '采集', description: '网页信息', status: 'disabled' },
  ];
  assert.deepEqual(viewModel.filterCards(cards, '办公', '').map((card) => card.id), ['one']);
  assert.deepEqual(viewModel.filterCards(cards, '', 'disabled').map((card) => card.id), ['two']);
  assert.deepEqual(viewModel.filterCards(cards, '网页', 'active'), []);
});

test('summarizes terminal runs and ignores active runs in success rate', () => {
  const summary = viewModel.cardRunSummary([
    { id: '3', card_id: 'card', status: 'running', created_at: 30 },
    { id: '2', card_id: 'card', status: 'failed', created_at: 20 },
    { id: '1', card_id: 'card', status: 'succeeded', created_at: 10 },
    { id: 'x', card_id: 'other', status: 'succeeded', created_at: 40 },
  ], 'card');
  assert.deepEqual(summary, { successRate: '50%', latestAt: 30000, latestStatus: 'running' });
});

test('normalizes deploy second timestamps and local millisecond timestamps to milliseconds', () => {
  const deploy = viewModel.normalizeRun({ id: 'deploy', created_at: 1_700_000_000 });
  const local = viewModel.normalizeRun({ id: 'local', createdAt: 1_700_000_000_123 });
  assert.equal(deploy.createdAt, 1_700_000_000_000);
  assert.equal(local.createdAt, 1_700_000_000_123);
});

test('round trips editable workflow metadata and validates input schema JSON', () => {
  const updated = viewModel.applyEditorMetadata({ name: '卡片', steps: [{}] }, {
    status: 'active', riskLevel: 'write', tags: 'a, b', accessScope: 'selected',
    inputSchema: '{"type":"object","properties":{"name":{"type":"string"}}}',
    timeoutSeconds: 60, maxTransitions: 25,
  });
  assert.equal(updated.enabled, true);
  assert.deepEqual(updated.tags, ['a', 'b']);
  assert.equal(updated.definition.limits.timeoutSeconds, 60);
  assert.equal(viewModel.editorMetadata(updated).accessScope, 'selected');
  assert.throws(() => viewModel.applyEditorMetadata({}, { inputSchema: '{bad' }), SyntaxError);
});

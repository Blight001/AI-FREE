'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createClipboard,
  createTimeline,
  pasteClipboard,
} = require('../../../src/app/renderer/controllers/pages/app-shell/automation-canvas-history');

function card(name, steps = []) {
  return { name, steps, flow: { start: steps[0]?.id || '', nodes: [], edges: [] } };
}

test('automation canvas history restores independent undo and redo snapshots', () => {
  const timeline = createTimeline(100);
  const initial = card('initial', [{ id: 'start', type: 'navigate' }]);
  const changed = card('changed', [{ id: 'start', type: 'navigate' }, { id: 'finish', type: 'end' }]);

  timeline.reset(initial);
  assert.equal(timeline.record(changed), true);
  changed.steps[1].type = 'delay';

  assert.deepEqual(timeline.undo(), initial);
  assert.deepEqual(timeline.redo(), card('changed', [
    { id: 'start', type: 'navigate' },
    { id: 'finish', type: 'end' },
  ]));
});

test('automation canvas history ignores duplicates and clears redo after a new edit', () => {
  const timeline = createTimeline(2);
  timeline.reset(card('one'));
  assert.equal(timeline.record(card('one')), false);
  timeline.record(card('two'));
  timeline.record(card('three'));
  assert.deepEqual(timeline.undo(), card('two'));
  timeline.record(card('replacement'));

  assert.equal(timeline.canRedo(), false);
  assert.equal(timeline.redo(), null);
  assert.deepEqual(timeline.undo(), card('two'));
});

test('cut clipboard restores the entry node and its surviving connections once', () => {
  const source = createClipboard({
    step: { id: 'start', type: 'delay', timeout: 500 },
    node: { id: 'start', x: 10, y: 20 },
    edges: [{ id: 'edge_1', from: 'start', to: 'finish', label: 'next' }],
    start: true,
    cut: true,
  });
  const withoutSource = {
    steps: [{ id: 'finish', type: 'end' }],
    flow: { start: 'finish', nodes: [{ id: 'finish', x: 100, y: 20 }], edges: [] },
  };

  const pasted = pasteClipboard(source, withoutSource);
  assert.equal(pasted.id, 'start');
  assert.equal(pasted.card.flow.start, 'start');
  assert.deepEqual(pasted.card.flow.edges, [{ id: 'edge_1', from: 'start', to: 'finish', label: 'next' }]);

  const copiedAgain = pasteClipboard(source, pasted.card);
  assert.notEqual(copiedAgain.id, 'start');
  assert.equal(copiedAgain.card.flow.edges.length, 1);
});

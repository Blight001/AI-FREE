'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { refreshTarget } = require('../../../src/app/backend/services/browser-workflow-target');

test('refreshTarget merges locator object with action-level scope and uniqueness filters', async () => {
  let inspected;
  const result = await refreshTarget({
    resolveObservedTarget: (_connection, args) => args,
    runtimeCommand: async (_connection, command, args) => {
      inspected = args.target;
      return { success: true, url: 'http://test/', target: {
        found: true, count: 1, visible: true, selector: '#asset-2', x: 10, y: 20, width: 30, height: 20,
      } };
    },
  }, { id: 'browser-1' }, {
    action: 'click', locator: { role: 'button', name: '添加到时间轴' },
    scope: '#timeline', nth: 1, exact: true, has_text: '素材 2',
  });

  assert.deepEqual(inspected, {
    role: 'button', name: '添加到时间轴', scope: '#timeline', nth: 1, exact: true, has_text: '素材 2',
  });
  assert.equal(result.strategy, 'fresh-semantic-target');
  assert.equal(result.input.selector, '#asset-2');
});

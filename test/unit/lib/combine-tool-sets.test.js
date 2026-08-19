'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { combineToolSets } = require('../../../src/app/main/services/combine-tool-sets');

test('combineToolSets merges catalogs and routes execution', async () => {
  const first = {
    tools: [{ name: 'alpha' }],
    has: (name) => name === 'alpha',
    execute: async () => ({ ok: 'a' }),
  };
  const second = {
    tools: [{ name: 'beta' }],
    has: (name) => name === 'beta',
    execute: async () => ({ ok: 'b' }),
  };
  const combined = combineToolSets(first, null, second);
  assert.deepEqual(combined.tools.map((tool) => tool.name), ['alpha', 'beta']);
  assert.equal(combined.has('beta'), true);
  assert.deepEqual(await combined.execute('beta', {}), { ok: 'b' });
  assert.throws(() => combined.execute('missing', {}), /未知工具/);
});

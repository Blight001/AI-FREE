'use strict';

const assert = require('node:assert/strict');
const { forbidden } = require('./values');

const operators = Object.freeze({
  equals: (actual, expected) => assert.deepEqual(actual, expected),
  includes: (actual, expected) => assert(actual.includes(expected)),
  oneOf: (actual, expected) => assert(expected.includes(actual)),
  exists: (actual, expected) => assert.equal(actual !== undefined && actual !== null, expected),
  truthy: (actual, expected) => assert.equal(Boolean(actual), expected),
});

function validateCheck(check) {
  assert(Object.keys(check).every((key) => ['path', 'op', 'value'].includes(key)), 'FLOW_UNKNOWN_ASSERTION_OPTION');
  assert(Object.hasOwn(operators, check.op), 'FLOW_UNKNOWN_ASSERTION');
  assert(typeof check.path === 'string' && Object.hasOwn(check, 'value'), 'FLOW_INVALID_ASSERTION');
  assert(check.path.split('.').every((key) => !forbidden.has(key)), 'FLOW_INVALID_ASSERTION_PATH');
}

module.exports = { operators, validateCheck };

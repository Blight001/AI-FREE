'use strict';

const assert = require('node:assert/strict');
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function readPath(value, location, allowMissing = false) {
  if (typeof location !== 'string') throw new Error('FLOW_INVALID_PATH');
  for (const key of location.split('.').filter(Boolean)) {
    if (forbidden.has(key)) throw new Error('FLOW_INVALID_PATH');
    if (value == null || !Object.hasOwn(value, key)) {
      if (allowMissing) return undefined;
      throw new Error('FLOW_REFERENCE_MISSING');
    }
    value = value[key];
  }
  return value;
}

function resolveValue(value, state) {
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, state));
  if (!value || typeof value !== 'object') return value;
  if (Object.hasOwn(value, '$ref')) {
    if (Object.keys(value).length !== 1) throw new Error('FLOW_INVALID_REFERENCE');
    return structuredClone(readPath(state, value.$ref));
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (forbidden.has(key)) throw new Error('FLOW_INVALID_KEY');
    return [key, resolveValue(child, state)];
  }));
}

function validateReferences(value, ids) {
  if (!value || typeof value !== 'object') return;
  if (Object.hasOwn(value, '$ref')) {
    assert.equal(Object.keys(value).length, 1, 'FLOW_INVALID_REFERENCE');
    assert.equal(typeof value.$ref, 'string', 'FLOW_INVALID_REFERENCE');
    const keys = value.$ref.split('.');
    assert(ids.has(keys[0]) && keys.every((key) => key && !forbidden.has(key)), 'FLOW_FORWARD_OR_UNKNOWN_REFERENCE');
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assert(!forbidden.has(key), 'FLOW_INVALID_KEY');
    validateReferences(child, ids);
  }
}

module.exports = { forbidden, readPath, resolveValue, validateReferences };

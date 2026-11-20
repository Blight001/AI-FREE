'use strict';

const assert = require('node:assert/strict');
const { forbidden, validateReferences } = require('./values');
const { validateCheck } = require('./assertions');

function validateStep(step, drivers, ids, contract) {
  assert(Object.keys(step).every((key) => ['id', 'use', 'args', 'expect'].includes(key)), 'FLOW_UNKNOWN_STEP_OPTION');
  assert(/^[a-z][a-zA-Z0-9]{0,63}$/.test(step.id) && !ids.has(step.id) && !forbidden.has(step.id), 'FLOW_DUPLICATE_OR_INVALID_STEP');
  assert(Object.hasOwn(drivers, step.use) && typeof drivers[step.use] === 'function', 'FLOW_UNKNOWN_DRIVER');
  if (contract) assert(Object.hasOwn(contract.operations, step.use), 'FLOW_UNDECLARED_CAPABILITY');
  assert(Array.isArray(step.expect) && step.expect.length > 0 && step.expect.length <= 32, 'FLOW_ASSERTION_REQUIRED');
  for (const check of step.expect) validateCheck(check);
  validateReferences([step.args, step.expect], ids);
  ids.add(step.id);
}

function validateFlow(flow, drivers, contract) {
  assert.equal(flow.schemaVersion, 1, 'FLOW_VERSION_UNSUPPORTED');
  assert(Object.keys(flow).every((key) => ['schemaVersion', 'domain', 'id', 'steps'].includes(key)), 'FLOW_UNKNOWN_OPTION');
  if (flow.domain !== undefined) assert.equal(flow.domain, contract?.id, 'FLOW_DOMAIN_MISMATCH');
  assert(/^[a-z][a-z0-9-]{0,79}$/.test(flow.id), 'FLOW_INVALID_ID');
  assert(Array.isArray(flow.steps) && flow.steps.length > 0 && flow.steps.length <= 200, 'FLOW_INVALID_STEPS');
  const ids = new Set(['input']);
  for (const step of flow.steps) {
    validateStep(step, drivers, ids, contract);
  }
  if (contract?.requireOracle) {
    assert(flow.steps.some((step) => contract.operations[step.use] === 'oracle'), 'FLOW_INDEPENDENT_ORACLE_REQUIRED');
  }
}

module.exports = { validateFlow };

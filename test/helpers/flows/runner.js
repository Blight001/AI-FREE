'use strict';

const { readPath, resolveValue } = require('./values');
const { validateFlow } = require('./schema');
const { operators } = require('./assertions');


async function executeFlowStep(step, { drivers, contract, state, signal }) {
  const started = Date.now();
  const evidence = contract?.operations[step.use] || 'driver';
  let phase = 'dispatch';
  let assertion;
  let value;
  try {
    value = await drivers[step.use](resolveValue(step.args || {}, state), { signal });
    phase = 'assertion';
    for (const check of step.expect) {
      assertion = { path: check.path, op: check.op };
      operators[check.op](readPath(value, check.path, check.op === 'exists'), resolveValue(check.value, state));
    }
    return { ok: true, value, report: { id: step.id, status: 'passed', evidence,
      assertionCount: step.expect.length, durationMs: Date.now() - started } };
  } catch (_) {
    // Arguments, result values and exception messages can contain page secrets.
    const driverCode = /^[A-Z][A-Z0-9_]{0,79}$/.test(value?.errorCode) ? value.errorCode : undefined;
    return { ok: false, value: undefined, report: { id: step.id, status: 'failed', evidence,
      code: 'FLOW_STEP_FAILED', phase, assertion, driverCode, durationMs: Date.now() - started } };
  }
}

/**
 * @param {any} flow
 * @param {{drivers: Record<string, Function>, contract?: any, input?: object, signal?: AbortSignal,
 *   onProgress?: (event: any) => void}} options
 */
async function runFlow(flow, { drivers, contract, input = {}, signal, onProgress = () => {} }) {
  flow = structuredClone(flow);
  input = structuredClone(input);
  validateFlow(flow, drivers, contract);
  const state = Object.create(null);
  state.input = input;
  const steps = [];
  for (const step of flow.steps) {
    if (signal?.aborted) return { ok: false, data: { id: flow.id, status: 'cancelled', steps } };
    onProgress({ id: step.id, status: 'starting' });
    const result = await executeFlowStep(step, { drivers, contract, state, signal });
    steps.push(result.report);
    onProgress(result.report);
    if (!result.ok) return { ok: false, data: { id: flow.id, status: 'failed', steps } };
    state[step.id] = result.value;
  }
  const cancelled = Boolean(signal?.aborted);
  return { ok: !cancelled, data: { id: flow.id, status: cancelled ? 'cancelled' : 'passed', steps } };
}

module.exports = { runFlow, validateFlow };

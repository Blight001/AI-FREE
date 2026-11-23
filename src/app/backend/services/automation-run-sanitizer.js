'use strict';

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /(?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|authorization|cookie|credential|private[_-]?key|account|e-?mail|user(?:name)?|login)/i;
const STEP_FIELDS = ['stepId', 'stepIndex', 'transitionCount', 'phase', 'attempt', 'type', 'success'];
const RESULT_FIELDS = ['success', 'ok', 'retryable', 'errorCode', 'code', 'stepIndex', 'actionExecuted',
  'sideEffectsMayHaveOccurred', 'uncertain'];

function collectSensitiveInputPaths(schema, prefix = 'inputs', output = []) {
  if (!schema || typeof schema !== 'object') return output;
  if (schema.writeOnly === true || schema.format === 'password') output.push(prefix);
  for (const [key, child] of Object.entries(schema.properties || {})) {
    const next = `${prefix}.${key}`;
    if (SENSITIVE_KEY.test(key)) output.push(next);
    else collectSensitiveInputPaths(child, next, output);
  }
  if (schema.items) collectSensitiveInputPaths(schema.items, `${prefix}[]`, output);
  return output;
}

function collectValues(value, values) {
  if (value == null || value === '' || value === REDACTED) return;
  if (typeof value === 'object') Object.values(value).forEach((child) => collectValues(child, values));
  else values.add(String(value));
}

function collectRequestSecrets(value, paths, values, path = '') {
  if (paths.has(path)) return collectValues(value, values);
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((child) => collectRequestSecrets(child, paths, values, `${path}[]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) collectValues(child, values);
    else collectRequestSecrets(child, paths, values, path ? `${path}.${key}` : key);
  }
}

// Literal replacement also covers punctuation and secrets embedded in a longer string.
// Keep the marker opaque across overlapping inputs and repeated history projections.
function redactText(text, literals) {
  let result = text;
  for (const literal of literals) {
    if (result.includes(literal)) {
      result = result.split(REDACTED).map((part) => part.replaceAll(literal, REDACTED)).join(REDACTED);
    }
  }
  return result;
}

function redactValue(value, secrets, literals) {
  if (typeof value === 'string') return redactText(value, literals);
  if (Array.isArray(value)) return value.map((child) => redactValue(child, secrets, literals));
  if (value == null) return value;
  if (typeof value !== 'object') return secrets.has(String(value)) ? REDACTED : value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    SENSITIVE_KEY.test(key) ? REDACTED : redactValue(child, secrets, literals)]));
}

// Only these fields at these specific envelope levels are protocol metadata.
// A same-named field inside a tool's data/context is still untrusted diagnostic data.
function redactEnvelope(value, controls, redact, overrides = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return redact(value);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (Object.hasOwn(overrides, key)) return [key, overrides[key](child)];
    if (controls.includes(key) && typeof child !== 'object') return [key, child];
    return [key, SENSITIVE_KEY.test(key) ? REDACTED : redact(child)];
  }));
}

function createAutomationRedactor(request = {}) {
  const secrets = new Set();
  collectRequestSecrets(request, new Set(request.sensitiveInputPaths || []), secrets);
  if (request.redactAllInputs === true) collectValues(request.inputs, secrets);
  let literals = [];
  function addInputs(values) { collectValues(values, secrets); }
  function redact(value) {
    if (literals.length !== secrets.size) literals = [...secrets].sort((a, b) => b.length - a.length);
    return redactValue(value, secrets, literals);
  }
  function redactStep(step) {
    return redactEnvelope(step, STEP_FIELDS, redact, {
      result: (result) => redactEnvelope(result, RESULT_FIELDS, redact),
    });
  }
  function redactResult(output) {
    return redactEnvelope(output, RESULT_FIELDS, redact, {
      execution: (steps) => Array.isArray(steps) ? steps.map(redactStep) : redact(steps),
    });
  }
  return { addInputs, redact, redactStep, redactResult };
}

function redactAutomationData(value, request) {
  return createAutomationRedactor(request).redactResult(value);
}

module.exports = { collectSensitiveInputPaths, createAutomationRedactor, redactAutomationData };

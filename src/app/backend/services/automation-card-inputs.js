'use strict';

const automationSchema = require('../../shared/automation-schema');

function text(value) { return String(value == null ? '' : value).trim(); }

function normalizeAutomationInputs(args, card) {
  const raw = args.inputs;
  if (raw !== undefined && (!raw || typeof raw !== 'object')) throw new Error('inputs 必须是对象或数组');
  const source = Array.isArray(raw)
    ? Object.fromEntries(raw.map((value, index) => [`var${index + 1}`, value]))
    : { ...(raw || {}) };
  let typeIndex = 0;
  for (const step of card.steps) {
    if (text(step.type).toLowerCase() !== 'type') continue;
    typeIndex += 1;
    const key = text(step.variable) || `var${typeIndex}`;
    if (source[key] === undefined) source[key] = step.text ?? '';
  }
  return source;
}

/** @param {Record<string, any>} schema @param {unknown} inputs */
function validateAutomationCardInputs(schema, inputs) {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw new Error('流程输入必须是对象');
  if (schema && typeof schema === 'object' && schema.type && schema.type !== 'object') {
    throw new Error('卡片 inputSchema 根类型必须是 object');
  }
  automationSchema.validate(inputs, schema || { type: 'object' }, 'inputs');
}

function versionInputSchema(entry, version) {
  return version.inputSchema || (version.id === entry.latestVersionId ? entry.inputSchema : null);
}

module.exports = { normalizeAutomationInputs, validateAutomationCardInputs, versionInputSchema };

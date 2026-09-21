'use strict';

const OPS = new Set(['equals', 'not_equals', 'contains', 'increases_by', 'changes', 'unchanged', 'exists']);
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX = 32;
const READS = new Set(['text', 'value', 'count', 'visible', 'attribute', 'duration', 'currentTime']);
const comparisons = {
  equals: (actual, _before, value) => actual === value,
  not_equals: (actual, _before, value) => actual !== value,
  contains: (actual, _before, value) => typeof actual === 'string' && actual.includes(String(value)),
  increases_by: (actual, before, value) => typeof actual === 'number' && typeof before === 'number' && actual - before === value,
  changes: (actual, before) => actual !== before,
  unchanged: (actual, before) => actual === before,
  exists: (actual) => actual !== null && actual !== undefined && actual !== '',
};

function validName(value) { return typeof value === 'string' && value.trim() && value.length <= 128 && !BAD_KEYS.has(value); }
function validateProbes(probes) {
  if (!Array.isArray(probes) || probes.length > MAX) return { valid: false, error: 'probes 数量必须为 0-32' };
  const names = new Set();
  for (const probe of probes) {
    if (!validName(probe?.name) || names.has(probe.name) || typeof probe.selector !== 'string' || !probe.selector.trim()
      || probe.selector.length > 4096 || !READS.has(probe.read || 'text')
      || (probe.attribute !== undefined && typeof probe.attribute !== 'string')) return { valid: false, error: 'probe name/selector/read/attribute 无效或重复' };
    names.add(probe.name);
  }
  return { valid: true, probes };
}
function validateChecks(checks) {
  if (!Array.isArray(checks) || checks.length > MAX) return { valid: false, error: 'checks 数量必须为 0-32' };
  const names = new Set();
  for (const check of checks) {
    if (!validName(check?.name) || names.has(check.name) || !OPS.has(check?.op)) return { valid: false, error: 'check name/op 无效或重复' };
    names.add(check.name);
    if (check.op === 'increases_by' && !Number.isFinite(check.value)) return { valid: false, error: 'increases_by 必须使用数字 value' };
    if (check.value !== undefined && (typeof check.value === 'string' ? check.value.length > 512 : typeof check.value === 'object')) return { valid: false, error: 'check value 无效' };
  }
  return { valid: true, checks };
}
function probe(snapshot, name) { return snapshot?.values?.[name] || { available: false, reason: '未提供 probe' }; }
function compareOne(before, after, check) {
  const a = probe(after, check.name); const b = probe(before, check.name);
  const needsBefore = ['increases_by', 'changes', 'unchanged'].includes(check.op);
  if (!a.available || (needsBefore && !b.available)) return { name: check.name, op: check.op, expected: check.value, actual: a.value, before: b.value, passed: false, reason: a.reason || b.reason || 'probe 不可用' };
  const actual = a.value; const previous = b.value;
  const passed = comparisons[check.op](actual, previous, check.value);
  return { name: check.name, op: check.op, expected: check.value, actual, before: previous, passed, reason: passed ? undefined : '条件不满足' };
}
function compareChecks(before, after, checks) {
  const validation = validateChecks(checks);
  if (!validation.valid) return { passed: false, checks: [], summary: validation.error };
  if (validation.checks.length === 0) return { status: 'not_configured', checks: [] };
  const results = checks.map((check) => compareOne(before, after, check));
  const passed = results.every((item) => item.passed);
  return { passed, checks: results, summary: passed ? '全部检查通过' : `有 ${results.filter((item) => !item.passed).length} 项检查未通过` };
}
module.exports = { validateProbes, validateChecks, compareChecks };

'use strict';

const { expiredObservedRefResult, mismatchedObservationResult } = require('./native-browser-observation');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TRANSIENT = new Set(['not_found', 'hidden', 'offscreen', 'occluded', 'NOT_FOUND', 'HIDDEN', 'OFFSCREEN', 'OCCLUDED']);

function locatorFor(input) {
  const base = input.locator && typeof input.locator === 'object' ? input.locator : {};
  return Object.fromEntries(Object.entries({
    ...base,
    test_id: input.testId ?? base.test_id, id: input.elementId ?? base.id,
    role: input.observedRole || input.role || base.role,
    name: input.observedLabel || input.label || base.name, selector: input.selector ?? base.selector,
    scope: input.scope ?? base.scope, nth: input.nth ?? base.nth, exact: input.exact ?? base.exact,
    has_text: input.has_text || input.hasText || base.has_text,
  }).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function targetFailure(target) {
  if (!target?.found) return target?.reason || 'not_found';
  if (target.count !== 1) return 'ambiguous';
  if (target.disabled) return 'disabled';
  if (!target.visible) return target.reason || 'hidden';
  if (target.occluded) return 'occluded';
  return '';
}

async function refreshTarget(host, connection, args) {
  let input = host.resolveObservedTarget(connection, args);
  if (input.observedRefRecoveryCandidate) {
    input = { ...input.observedRefRecoveryCandidate, ...args };
  }
  const invalid = mismatchedObservationResult(input) || expiredObservedRefResult(input);
  if (invalid) return { failure: { ...invalid, actionExecuted: false } };
  const target = locatorFor(input);
  if (!Object.keys(target).length) return { input: host.runtimeTarget(input), strategy: 'coordinates-or-focused-input' };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const state = await host.runtimeCommand(connection, 'inspect-page-state', { target });
    if (state.success === false) return { failure: { ...state, actionExecuted: false } };
    if (input.observedUrl && input.observedUrl !== state.url) {
      return { failure: { success: false, errorCode: 'DOCUMENT_CHANGED', error: '页面已切换，请重新观察', actionExecuted: false } };
    }
    const reason = targetFailure(state.target);
    if (state.target?.inputType === 'file' && ['click', 'double_click'].includes(args.action)) {
      return { failure: { success: false, errorCode: 'FILE_UPLOAD_REQUIRED', error: '请使用 browser_file action=upload 并附带文件', actionExecuted: false } };
    }
    if (!reason) return { input: relocatedInput(args, state.target), strategy: 'fresh-semantic-target', attempts: attempt + 1 };
    if (attempt === 0 && TRANSIENT.has(reason)) { await wait(150); continue; }
    return { failure: { success: false, errorCode: 'TARGET_NOT_ACTIONABLE', reason, error: `目标无法操作：${reason}`, actionExecuted: false } };
  }
  return { failure: { success: false, errorCode: 'TARGET_NOT_ACTIONABLE', actionExecuted: false } };
}

function relocatedInput(args, target) {
  const { ref: _ref, observation_id: _observation, locator: _locator, ...input } = args;
  return { ...input, selector: target.selector,
    x: target.clickX ?? target.x + target.width / 2, y: target.clickY ?? target.y + target.height / 2 };
}

module.exports = { refreshTarget, wait };

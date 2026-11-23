'use strict';

const { safeToRetry, uncertainOutcome } = require('./automation-execution-outcome');
const { normalizeAutomationInputs, validateAutomationCardInputs } = require('./automation-card-inputs');
const { collectSensitiveInputPaths, redactAutomationData } = require('./automation-run-sanitizer');

function text(value) { return String(value == null ? '' : value).trim(); }

function substitute(value, inputs) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{([^{}]+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(inputs, key) ? String(inputs[key]) : match
  ));
}

function materializeValue(value, inputs) {
  if (typeof value === 'string') {
    const exact = /^\{([^{}]+)\}$/.exec(value);
    return exact && Object.hasOwn(inputs, exact[1]) ? inputs[exact[1]] : substitute(value, inputs);
  }
  if (Array.isArray(value)) return value.map((item) => materializeValue(item, inputs));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, materializeValue(item, inputs)]));
}

function materializeStep(step, inputs) {
  const result = materializeValue(step || {}, inputs);
  if (text(result.type).toLowerCase() === 'type') {
    const variable = text(result.variable);
    if (variable && inputs[variable] !== undefined) result.text = String(inputs[variable]);
  }
  return result;
}

function nextFlowIndex(card, currentIndex, branch) {
  const current = card.steps[currentIndex] || {};
  const currentId = text(current.id) || `step_${currentIndex + 1}`;
  const edges = Array.isArray(card.flow?.edges) ? card.flow.edges : [];
  const labels = branch === undefined ? ['next', 'default', ''] : [String(branch), 'default', 'next'];
  const edge = edges.find((item) => text(item.from || item.source) === currentId
    && labels.includes(text(item.label || item.branch || 'next').toLowerCase()));
  if (!edge) return -1;
  const target = text(edge.to || edge.target);
  return card.steps.findIndex((step, index) => (text(step.id) || `step_${index + 1}`) === target);
}

function initialStepIndex(card, args) {
  const requested = Number(args.start_step || 0);
  if (requested > 0) return Math.max(0, requested - 1);
  const startId = text(card.flow?.start);
  if (!startId) return 0;
  const found = card.steps.findIndex((step, index) => (text(step.id) || `step_${index + 1}`) === startId);
  return found >= 0 ? found : 0;
}

function cancellationError() {
  const error = /** @type {Error & {errorCode?:string,retryable?:boolean}} */ (new Error('自动化运行已取消'));
  error.errorCode = 'RUN_CANCELLED';
  error.retryable = false;
  return error;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancellationError();
}

function waitForRetry(ms, signal) {
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const completed = () => { signal?.removeEventListener?.('abort', aborted); resolve(undefined); };
    const timer = setTimeout(completed, Math.max(0, Number(ms) || 0));
    const aborted = () => { clearTimeout(timer); reject(cancellationError()); };
    signal?.addEventListener?.('abort', aborted, { once: true });
  });
}

async function openCardWebsite(card, args, dispatch, execution) {
  if (Number(args.start_step || 0) > 1 || text(card.steps[0]?.type).toLowerCase() === 'navigate') return;
  const url = text(card.website);
  if (!url) return;
  const step = { name: '打开卡片网站', type: 'navigate' };
  try {
    const listed = await dispatch('browser_tab', { action: 'list' });
    const inspectError = stepResultError(step, listed);
    if (inspectError) throw inspectError;
    if (/^https?:\/\//i.test(url) && listed?.activeTab?.url === url) return;
    const result = await dispatch('browser_tab', { action: 'replace', url });
    const navigationError = stepResultError(step, result);
    if (navigationError) throw navigationError;
    execution.push({ stepIndex: 0, ...step, success: true, result });
  } catch (error) {
    execution.push({ stepIndex: 0, ...step, success: false, error: error?.message || String(error) });
    return error;
  }
}

function invalidProbe() {
  return Object.assign(new Error('未取得可验证的页面条件结果'), { errorCode: 'CARD_CONDITION_UNAVAILABLE' });
}

async function selectorCondition(step, mode, dispatch) {
  const selector = text(step.selector || step.wait_for_element);
  if (!selector) throw invalidProbe();
  const probe = await dispatch('browser_wait', { condition: 'attached', selector, timeout_ms: 100 });
  // A wait may also time out without reaching the document. Only a DOM response
  // that evaluated this condition can establish that the selector was absent.
  const absent = probe?.success === false && probe.errorCode === 'WAIT_TIMEOUT' && probe.condition === 'attached';
  if (!absent) {
    const failure = stepResultError({ type: 'browser_wait' }, probe);
    if (failure) throw failure;
    if (probe?.success !== true || probe.condition !== 'attached') throw invalidProbe();
  }
  return { success: mode === 'selector_missing' ? absent : !absent };
}

async function urlCondition(step, dispatch) {
  const listed = await dispatch('browser_tab', { action: 'list' });
  const failure = stepResultError({ type: 'browser_tab' }, listed);
  if (failure) throw failure;
  const url = text(listed?.activeTab?.url);
  const expected = text(step.url || step.text);
  if (!url || !expected) throw invalidProbe();
  return { success: url.includes(expected), matched: url };
}

async function executeCondition(step, dispatch) {
  const mode = text(step.condition_mode || step.condition || 'selector_exists').toLowerCase();
  if (mode === 'selector_exists' || mode === 'selector_missing') return selectorCondition(step, mode, dispatch);
  if (mode === 'url_matches') return urlCondition(step, dispatch);
  const keyword = text(step.text || step.wait_for_text);
  if (!['text_exists', 'text_missing'].includes(mode) || !keyword) throw invalidProbe();
  const observe = await dispatch('browser_observe', { keyword, include_text: true, limit: 20, mark: false });
  const failure = stepResultError({ type: 'browser_observe' }, observe);
  if (failure) throw failure;
  if (observe?.success !== true || !Array.isArray(observe.items)) throw invalidProbe();
  return { ...observe, success: mode === 'text_missing' ? !observe.items.length : !!observe.items.length };
}

function waitArguments(step) {
  const args = { ...step };
  if (!args.selector && step.wait_for_element !== undefined) args.selector = step.wait_for_element;
  // Native fixed waits read ms; conditional waits read timeout_ms first, then ms.
  if (args.ms === undefined && step.timeout !== undefined) args.ms = step.timeout;
  return args;
}

function dispatchRequest(step) {
  const type = text(step.type).toLowerCase();
  if (type === 'navigate') return ['browser_tab', { action: 'replace', url: step.url }];
  if (type === 'click' || type === 'type') return ['browser_action', { ...step, action: type }];
  if (type === 'wait') return ['browser_wait', waitArguments(step)];
  if (type === 'save_cookies') return ['browser_file', { ...step, action: 'save_session' }];
  if (type === 'screenshot') return ['browser_screenshot', step];
  if (type === 'get_credits') return ['browser_observe', { keyword: step.selector || step.text, limit: 10, mark: false }];
  if (type === 'mcp') return [text(step.tool), step.arguments ?? step.args ?? {}];
  return null;
}

async function executeStep(step, dispatch, context = {}) {
  const type = text(step.type).toLowerCase();
  if (type === 'delay') {
    const delayMs = Number(step.delayMs ?? step.timeout ?? (Number(step.delaySeconds ?? step.seconds ?? 0) * 1000));
    await waitForRetry(delayMs, context.signal);
    return { success: true, delayMs };
  }
  if (type === 'condition') return executeCondition(step, dispatch);
  if (type === 'clear_current_page_cache') throw new Error('当前 Chromium 原生协议尚未开放清理当前站点数据命令');
  const request = dispatchRequest(step);
  if (!request) throw new Error(`未知卡片步骤类型: ${type}`);
  return dispatch(request[0], request[1]);
}

function retryPolicy(step) {
  const source = step.retryPolicy && typeof step.retryPolicy === 'object' ? step.retryPolicy : {};
  return {
    maxAttempts: Math.min(10, Math.max(1, Number(source.maxAttempts || step.max_attempts || 1))),
    delayMs: Math.max(0, Number(source.delaySeconds ?? step.retry_delay ?? 0) * 1000),
    exponential: source.backoff === 'exponential',
  };
}

async function executeStepWithRetry(step, dispatch, context, progressBase) {
  const policy = retryPolicy(step);
  let lastError;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    throwIfCancelled(context.signal);
    context.onProgress?.({ ...progressBase, phase: 'started', attempt });
    try {
      const result = await executeStep(step, dispatch, context);
      const resultError = stepResultError(step, result);
      if (resultError) throw resultError;
      context.onProgress?.({ ...progressBase, phase: 'succeeded', attempt, success: true, result });
      return result;
    } catch (error) {
      lastError = error;
      context.onProgress?.({ ...progressBase, phase: 'failed', attempt, success: false, error: error?.message || String(error) });
      if (attempt >= policy.maxAttempts || !safeToRetry(error)) throw error;
      const delay = policy.exponential ? policy.delayMs * (2 ** (attempt - 1)) : policy.delayMs;
      await waitForRetry(Math.min(60000, delay), context.signal);
    }
  }
  throw lastError;
}

function failedStepResult(error, index, inputs, execution) {
  const priorEffects = execution.some((step) => step.sideEffectsMayHaveOccurred || uncertainOutcome(step.result));
  return {
    success: false,
    errorCode: error?.errorCode || error?.code || 'CARD_STEP_FAILED',
    retryable: !priorEffects && safeToRetry(error),
    sideEffectsMayHaveOccurred: priorEffects || uncertainOutcome(error),
    error: error?.message || String(error),
    stepIndex: index + 1,
    context: inputs,
    execution,
  };
}

function conditionMustPass(step) {
  return text(step.type).toLowerCase() === 'condition' && step.fail_on_false === true;
}

function toolResultFailed(step, result) {
  if (text(step.type).toLowerCase() === 'condition') return false;
  return result?.success === false || result?.ok === false;
}

function resultErrorMessage(step, result, failedCondition) {
  const reported = text(result?.error?.message || result?.error || result?.errorReason || result?.message);
  if (reported) return reported;
  if (failedCondition) return `条件未满足: ${text(step.name) || text(step.condition_mode) || 'condition'}`;
  return `步骤执行失败: ${text(step.name) || text(step.type) || 'unknown'}`;
}

function stepResultError(step, result) {
  const failedCondition = conditionMustPass(step) && result?.success !== true;
  const failedTool = toolResultFailed(step, result);
  if (!failedCondition && !failedTool) return null;
  const error = /** @type {Error & {errorCode?: string,retryable?:boolean,sideEffectsMayHaveOccurred?:boolean}} */ (
    new Error(resultErrorMessage(step, result, failedCondition))
  );
  error.errorCode = text(result?.errorCode || result?.error?.code || result?.code)
    || (failedCondition ? 'CARD_CONDITION_FAILED' : 'CARD_STEP_FAILED');
  error.retryable = safeToRetry(result);
  error.sideEffectsMayHaveOccurred = uncertainOutcome(result);
  return error;
}

function stepProgress(step, index, count) {
  return {
    stepId: text(step.id) || `step_${index + 1}`, stepIndex: index + 1,
    transitionCount: count + 1, type: step.type, name: text(step.name),
  };
}

function finishAtEnd(step, index, count, execution, context) {
  context.onProgress?.({ ...stepProgress(step, index, count), phase: 'succeeded', success: true });
  execution.push({ stepIndex: index + 1, name: text(step.name), type: 'end', success: true, result: { ended: true } });
  return { ended: true };
}

function nextStepIndex(card, index, step, result) {
  const next = card.flow
    ? nextFlowIndex(card, index, text(step.type) === 'condition' ? result.success : undefined)
    : index + 1;
  return next >= card.steps.length ? -1 : next;
}

async function runOneStep(card, index, count, inputs, execution, dispatch, context) {
  throwIfCancelled(context.signal);
  const step = materializeStep(card.steps[index], inputs);
  if (text(step.type).toLowerCase() === 'end') return finishAtEnd(step, index, count, execution, context);
  try {
    const result = await executeStepWithRetry(step, dispatch, context, stepProgress(step, index, count));
    execution.push({ stepIndex: index + 1, name: text(step.name), type: step.type, success: true, result });
    return { next: nextStepIndex(card, index, step, result) };
  } catch (error) {
    execution.push({ stepIndex: index + 1, name: text(step.name), type: step.type, success: false,
      ...(uncertainOutcome(error) && { sideEffectsMayHaveOccurred: true }), error: error?.message || String(error) });
    if (step.optional === true) return { next: index + 1 };
    return { failed: failedStepResult(error, index, inputs, execution) };
  }
}

async function runCard(card, args, dispatch, context = {}) {
  const inputs = normalizeAutomationInputs(args, card);
  validateAutomationCardInputs(context.inputSchema, inputs);
  context.addInputs?.(inputs);
  const redaction = {
    inputs,
    sensitiveInputPaths: collectSensitiveInputPaths(context.inputSchema),
    redactAllInputs: context.redactAllInputs === true,
  };
  let index = initialStepIndex(card, args);
  let count = 0;
  const execution = [];
  throwIfCancelled(context.signal);
  const openingError = await openCardWebsite(card, args, dispatch, execution);
  if (openingError) return redactAutomationData(failedStepResult(openingError, -1, inputs, execution), redaction);
  const maxTransitions = Math.max(1, Number(context.maxTransitions || Math.max(120, card.steps.length * 20)));
  while (index >= 0 && count < maxTransitions) {
    await context.beforeStep?.({ stepId: text(card.steps[index]?.id) || `step_${index + 1}`, transitionCount: count });
    throwIfCancelled(context.signal);
    const outcome = await runOneStep(card, index, count, inputs, execution, dispatch, context);
    if (outcome.failed) return redactAutomationData(outcome.failed, redaction);
    if (outcome.ended) break;
    index = outcome.next;
    count += 1;
  }
  if (count >= maxTransitions) throw new Error('自动化卡片流程超过安全步数限制');
  return redactAutomationData({ success: true, cardName: text(card.name), context: inputs, execution }, redaction);
}

module.exports = { runCard };

'use strict';

const RETRYABLE_WAIT_ERRORS = new Set(['INPUT_TARGET_UNAVAILABLE', 'WEB_CONTENTS_UNAVAILABLE']);

function boundedWaitTimeout(input) {
  return Math.min(120000, Math.max(100, Number(input.timeout_ms ?? input.ms) || 10000));
}

function retryDelay(timeoutMs) {
  return new Promise((resolve) => setTimeout(resolve, Math.min(100, timeoutMs)));
}

function timeoutResult(selector, timeoutMs, result) {
  return {
    ...(result || {}), success: false, action: 'wait', selector,
    error: `等待元素超时: ${selector}`, errorCode: 'WAIT_TIMEOUT', timeout_ms: timeoutMs,
  };
}

function unsupportedConditionResult(condition) {
  return {
    success: false, action: 'wait', condition,
    errorCode: 'BROWSER_RUNTIME_UPDATE_REQUIRED', retryable: false,
    error: '当前 Chromium Runtime 尚未支持条件等待；请重新构建并替换 resources/chromium 后重启 AI-FREE-app。',
  };
}

function conditionWasIgnored(input, result) {
  return !!input.condition && result?.success === true && result?.condition !== input.condition;
}

async function runAttempt(options) {
  const { runtimeCommand, input, selector, remaining, initialValue } = options;
  try {
    const result = await runtimeCommand({
      ...input, selector, action: 'wait',
      ...(initialValue === undefined ? {} : { initial_value: initialValue }),
      timeout_ms: Math.min(750, remaining),
    });
    if (conditionWasIgnored(input, result)) {
      return { result: unsupportedConditionResult(input.condition), retryable: false };
    }
    return { result, retryable: result?.success === false && result?.errorCode === 'WAIT_TIMEOUT' };
  } catch (error) {
    if (!RETRYABLE_WAIT_ERRORS.has(String(error?.code || ''))) throw error;
    return { result: null, retryable: true };
  }
}

function nextInitialValue(condition, initialValue, result) {
  if (initialValue !== undefined || condition !== 'text_changed') return initialValue;
  return result?.currentValue;
}

async function waitForBrowserCondition(options) {
  const timeoutMs = boundedWaitTimeout(options.input);
  const deadline = Date.now() + timeoutMs;
  let result = null;
  let initialValue = options.input.initial_value ?? options.input.initialValue;
  do {
    const attempt = await runAttempt({
      ...options, remaining: Math.max(100, deadline - Date.now()), initialValue,
    });
    result = attempt.result;
    initialValue = nextInitialValue(options.condition, initialValue, result);
    if (!attempt.retryable) return result;
    if (Date.now() < deadline) await retryDelay(deadline - Date.now());
  } while (Date.now() < deadline);
  return timeoutResult(options.selector || options.condition, timeoutMs, result);
}

module.exports = { waitForBrowserCondition };

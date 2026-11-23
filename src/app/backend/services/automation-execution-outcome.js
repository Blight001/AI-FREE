'use strict';

function uncertainOutcome(outcome) {
  return Boolean(outcome?.uncertain || outcome?.sideEffects || outcome?.sideEffectsMayHaveOccurred
    || ['uncertain', 'unknown'].includes(outcome?.outcome) || outcome?.outcomeUnknown || outcome?.actionExecuted === true || outcome?.actionExecuted === 'unknown');
}

function safeToRetry(error) {
  return error?.retryable === true && !uncertainOutcome(error) && error.errorCode !== 'RUN_CANCELLED';
}

module.exports = { safeToRetry, uncertainOutcome };

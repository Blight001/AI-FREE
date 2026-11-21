'use strict';

const { appContext } = require('../runtime/app-context');
const { redactSensitiveText } = require('./chromium-diagnostic-redaction');
const { RUNTIME_STATUS } = require('./runtime-types');

const RECOVERY_COOLDOWN_MS = 60_000;

function describeFailure(error, diagnostics, logFilePath) {
  return {
    code: error.code || 'CHROMIUM_RUNTIME_ERROR', message: error.message || String(error),
    stack: error.stack, diagnostic: error.diagnostic || diagnostics?.summarize(),
    logFilePath: error.logFilePath || diagnostics?.logFilePath || logFilePath,
    diagnosticBundlePath: error.diagnosticBundlePath,
  };
}

function describeProcess(state, child, error) {
  return {
    pid: state?.pid || child?.pid || 0, status: state?.status,
    exitCode: error.exitCode ?? child?.exitCode ?? null, signal: error.signal || child?.signalCode,
  };
}

function logChromiumFailure(runtime, label, profileId, state, instance, error = {}) {
  const { chromiumUserDataDir, chromiumLogPath } = runtime.launchOptions || {};
  const redact = (text) => redactSensitiveText(text, { userDataDir: chromiumUserDataDir });
  const fields = describeFailure(error, instance?.diagnostics, chromiumLogPath);
  const lastError = { code: redact(fields.code), message: redact(fields.message) };
  const { signal, ...processDetails } = describeProcess(state, instance?.child, error);
  const details = {
    ...lastError, stack: redact(fields.stack), diagnostic: redact(fields.diagnostic),
    logFilePath: redact(fields.logFilePath), diagnosticBundlePath: redact(fields.diagnosticBundlePath),
    ...processDetails, profileId: redact(profileId), signal: redact(signal),
  };
  // Pass only diagnostic fields, not command payloads, profile settings or Error.cause.
  runtime.logger?.error?.(`[ChromiumRuntime] ${label}`, details);
  return lastError;
}

/** @param {Map<string, {visible: boolean, cancelled: boolean, task?: Promise<void>}>} attempts */
function cancelChromiumRecovery(attempts, profileId) {
  const attempt = attempts.get(profileId);
  if (!attempt) return null;
  attempt.cancelled = true;
  return attempt.task;
}

function queueChromiumRecovery(runtime, profileId, instance, attempt) {
  const attempts = runtime.crashRecoveryAttempts;
  const queued = runtime.enqueueProfileOperation(profileId, () => {
    if (attempt.cancelled || appContext.isShuttingDown() || runtime.instances.get(profileId) !== instance
      || runtime.stateStore.getState(profileId)?.status !== RUNTIME_STATUS.CRASHED) return;
    attempt.task = recoverChromium(runtime, profileId, attempt);
    return attempt.task;
  });
  void queued.catch((error) => {
    logChromiumFailure(runtime, '自动重启失败', profileId, runtime.getState(profileId), runtime.instances.get(profileId), error);
  }).finally(() => {
    if (attempts.get(profileId) === attempt) attempts.delete(profileId);
  });
}

async function recoverChromium(runtime, profileId, attempt) {
  runtime.logger?.warn?.('[ChromiumRuntime] 正在自动重启故障浏览器', { profileId });
  await runtime.restartNow(profileId, { recovery: attempt });
}

function scheduleChromiumRecovery(runtime, profileId, instance, state) {
  const attempts = runtime.crashRecoveryAttempts;
  if (!instance || attempts.has(profileId) || appContext.isShuttingDown()) return;
  if (Date.now() - (instance.autoRecoveredAt || 0) < RECOVERY_COOLDOWN_MS) {
    runtime.logger?.warn?.('[ChromiumRuntime] 浏览器短时间内再次故障，停止自动重启', { profileId });
    return;
  }
  const attempt = { visible: state.status === RUNTIME_STATUS.READY, cancelled: false };
  attempts.set(profileId, attempt);
  queueChromiumRecovery(runtime, profileId, instance, attempt);
}

function markChromiumCrashed(runtime, profileId, error, instance) {
  const state = runtime.stateStore.getState(profileId);
  if (!state || instance !== runtime.instances.get(profileId) || instance?.expectedExit
    || [RUNTIME_STATUS.STOPPED, RUNTIME_STATUS.STOPPING, RUNTIME_STATUS.CRASHED].includes(state.status)) return;
  const wasRunning = runtime.isProfileRunning(profileId);
  const lastError = wasRunning ? logChromiumFailure(runtime, '浏览器运行故障', profileId, state, instance, error) : error;
  if (wasRunning) {
    const failure = Object.assign(new Error(lastError.message), { code: lastError.code });
    instance?.commandClient?.rejectPending?.(failure);
    scheduleChromiumRecovery(runtime, profileId, instance, state);
  }
  instance?.monitor?.stop();
  try { runtime.windowBridge.hideHostWindow(state.hostHwnd); } catch (_) {}
  runtime.stateStore.patchState(profileId, { status: RUNTIME_STATUS.CRASHED, browserHwnd: null,
    bridgeConnected: false, embedded: false, lastError, crashCount: Number(state.crashCount || 0) + 1 });
  runtime.emit('crashed', runtime.getState(profileId));
}

module.exports = { cancelChromiumRecovery, logChromiumFailure, markChromiumCrashed };

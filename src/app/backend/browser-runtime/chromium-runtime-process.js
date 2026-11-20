'use strict';

const crypto = require('crypto');
const { spawn } = require('child_process');
const {
  captureChromiumSessionFiles,
  loadStableChromiumSession,
  persistStableChromiumSession,
  restoreChromiumSessionFiles,
  snapshotHasRestorableSession,
} = require('./chromium-session-recovery');
const { RUNTIME_STATUS } = require('./runtime-types');
const { createChromiumPerformanceSpan } = require('./chromium-performance');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sessionSnapshotDigest(snapshot) {
  if (!snapshot?.files?.length) return '';
  const hash = crypto.createHash('sha256');
  for (const file of [...snapshot.files].sort((left, right) => left.name.localeCompare(right.name))) {
    hash.update(String(file.name || ''));
    hash.update(file.data);
  }
  return hash.digest('hex');
}

async function waitForSettledChromiumSession(paths, timeoutMs = 3000) {
  const deadline = Date.now() + Math.max(500, Number(timeoutMs) || 3000);
  let previousDigest = '';
  let stableReads = 0;
  let latestSnapshot = null;
  while (Date.now() < deadline) {
    const snapshot = captureChromiumSessionFiles(paths, null);
    const digest = sessionSnapshotDigest(snapshot);
    if (digest && digest === previousDigest) {
      stableReads += 1;
      latestSnapshot = snapshot;
      if (stableReads >= 3) return latestSnapshot;
    } else {
      previousDigest = digest;
      stableReads = digest ? 1 : 0;
      latestSnapshot = snapshot;
    }
    await delay(100);
  }
  return latestSnapshot;
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(child.exitCode !== null), Math.max(100, timeoutMs));
    child.once('exit', onExit);
  });
}

function terminateProcessTree(pid, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try { killer.kill(); } catch (_) {}
      finish(false);
    }, Math.max(1000, timeoutMs));
    killer.once('error', () => finish(false));
    killer.once('exit', (code) => finish(code === 0 || code === 128));
  });
}

async function stopChromiumProfile(runtime, profileId, options = {}) {
  const id = String(profileId);
  const state = runtime.stateStore.getState(id);
  const instance = runtime.instances.get(id);
  if (!state) return null;
  const performanceSpan = createChromiumPerformanceSpan(runtime.logger, 'stop');
  if (![RUNTIME_STATUS.STOPPING, RUNTIME_STATUS.STOPPED].includes(state.status)) {
    runtime.stateStore.transition(id, RUNTIME_STATUS.STOPPING);
  }
  performanceSpan.mark('stateTransition');
  try {
    if (instance) await shutdownChromiumInstance(runtime, id, instance, options, performanceSpan);
  } catch (error) {
    await markChromiumStopFailed(runtime, id, instance, state, error);
    performanceSpan.fail(error);
    throw error;
  }
  await finalizeStoppedProfile(runtime, id, instance, state);
  performanceSpan.mark('finalize');
  performanceSpan.finish();
  return runtime.getState(id);
}

async function finalizeStoppedProfile(runtime, id, instance, state) {
  await instance?.resources?.dispose({ processExited: true });
  if (!instance || runtime.instances.get(id) === instance) runtime.instances.delete(id);
  runtime.store.releaseLock(id);
  runtime.stateStore.patchState(id, {
    status: RUNTIME_STATUS.STOPPED,
    stoppedAt: Date.now(),
    browserHwnd: null,
    hostHwnd: null,
    pid: 0,
    sessionId: '',
    bridgeConnected: false,
    embedded: false,
  });
}

async function markChromiumStopFailed(runtime, id, instance, state, error) {
  await instance?.resources?.dispose({ processExited: false }).catch(() => {
    runtime.logger?.warn?.('[ChromiumRuntime] 关闭失败后的资源释放失败，保留原始关闭错误');
  });
  runtime.stateStore.patchState(id, {
    status: RUNTIME_STATUS.CRASHED,
    browserHwnd: null,
    hostHwnd: null,
    bridgeConnected: false,
    embedded: false,
    lastError: { code: error.code || 'CHROMIUM_STOP_FAILED', message: error.message },
  });
  scheduleLateExitCleanup(runtime, id, instance);
}

function scheduleLateExitCleanup(runtime, id, instance) {
  if (!instance?.child) return;
  if (instance.child.exitCode !== null) {
    void instance.resources?.dispose({ processExited: true }).catch(() => runtime.logger?.warn?.('[ChromiumRuntime] 延迟资源释放失败'));
    return;
  }
  instance.child.once('exit', () => {
    if (runtime.instances.get(id) !== instance) return;
    void instance.resources?.dispose({ processExited: true }).catch(() => runtime.logger?.warn?.('[ChromiumRuntime] 延迟资源释放失败'));
    runtime.instances.delete(id);
    runtime.store.releaseLock(id);
    const current = runtime.stateStore.getState(id);
    if (!current || Number(current.pid || 0) !== Number(instance.child.pid || 0)) return;
    runtime.stateStore.patchState(id, { status: RUNTIME_STATUS.STOPPED, pid: 0, stoppedAt: Date.now() });
  });
}

async function cleanupFailedChromiumLaunch(runtime, profileId, context) {
  const id = String(profileId);
  const instance = runtime.instances.get(id);
  runtime.unbindParentWindowFocus(instance);
  const processOwner = instance || { child: context.resources.child, expectedExit: true };
  const processExited = await terminateFailedLaunch(processOwner);
  await context.resources.dispose({ processExited }).catch(() => {
    runtime.logger?.warn?.('[ChromiumRuntime] 启动失败后的资源释放失败，保留原始启动错误');
  });
  if (processExited) {
    runtime.instances.delete(id);
    runtime.store.releaseLock(id);
  }
  patchFailedLaunchState(runtime, id, instance, context.error, processExited);
  if (!processExited) scheduleLateExitCleanup(runtime, id, instance);
}

async function terminateFailedLaunch(instance) {
  if (!instance?.child || instance.child.exitCode !== null) return true;
  instance.expectedExit = true;
  try { await terminateProcessTree(instance.child.pid, 5000); } catch (_) {}
  return waitForChildExit(instance.child, 5000);
}

function patchFailedLaunchState(runtime, id, instance, error, processExited) {
  const state = runtime.stateStore.getState(id);
  if (!state) return;
  const cleanupFailed = !processExited;
  runtime.stateStore.patchState(id, {
    status: RUNTIME_STATUS.CRASHED,
    pid: cleanupFailed ? Number(instance?.child?.pid || state.pid || 0) : 0,
    hostHwnd: null,
    browserHwnd: null,
    sessionId: '',
    bridgeConnected: false,
    embedded: false,
    lastError: {
      code: cleanupFailed ? 'CHROMIUM_PROCESS_EXIT_TIMEOUT' : (error.code || 'CHROMIUM_LAUNCH_FAILED'),
      message: cleanupFailed ? `${error.message}；失败进程未能退出` : error.message,
    },
  });
}

async function shutdownChromiumInstance(runtime, id, instance, options, performanceSpan) {
  const preserveSession = options.preserveSession !== false;
  const preCloseSnapshot = preserveSession ? captureChromiumSessionFiles(instance.paths, null) : null;
  const stableSnapshot = preserveSession ? loadStableChromiumSession(instance.paths, runtime.logger) : null;
  performanceSpan.mark('sessionSnapshot');
  instance.expectedExit = true;
  instance.monitor?.stop();
  runtime.unbindParentWindowFocus(instance);
  performanceSpan.mark('runtimeTeardown');
  // Chromium may terminate before its bridge can acknowledge close-browser.
  // Start the request, but measure the graceful-exit deadline from the user
  // action instead of serially adding the command timeout to the exit timeout.
  const closeRequest = instance.commandClient.send('close-browser', {}, { timeoutMs: 3000 })
    .catch(() => null);
  performanceSpan.mark('closeRequest');
  await waitForGracefulChromiumExit(instance, options);
  performanceSpan.mark('gracefulExit');
  if (instance.child.exitCode === null) {
    await forceChromiumExit(instance, options);
    performanceSpan.mark('forceExit');
  }
  if (instance.child.exitCode === null) throwChromiumExitTimeout(id);
  if (preserveSession) await preserveChromiumSession(runtime, id, instance, preCloseSnapshot, stableSnapshot);
  performanceSpan.mark('sessionPersist');
  performanceSpan.mark('transportClose');
  void closeRequest;
}

async function waitForGracefulChromiumExit(instance, options) {
  const deadline = Date.now() + Math.max(500, Number(options.timeoutMs) || 4000);
  while (instance.child.exitCode === null && Date.now() < deadline) await delay(100);
}

async function forceChromiumExit(instance, options) {
  if (options.force === false) {
    try { instance.child.kill(); } catch (_) {}
  } else {
    await terminateProcessTree(instance.child.pid);
  }
  await waitForChildExit(instance.child, 5000);
}

function throwChromiumExitTimeout(id) {
  const error = /** @type {Error & {code?: string}} */ (new Error(`Chromium Profile ${id} 进程未能在超时内退出`));
  error.code = 'CHROMIUM_PROCESS_EXIT_TIMEOUT';
  throw error;
}

async function restartChromiumProfile(runtime, profileId, options = {}) {
  const id = String(profileId);
  const instance = runtime.instances.get(id);
  const state = runtime.stateStore.getState(id);
  if (!instance || !state) throw new Error(`Chromium Profile ${id} 不存在`);
  const profile = { ...instance.profile };
  if (options.compatibilityMode === true) {
    profile.extraArgs = Array.from(new Set([...(profile.extraArgs || []), '--disable-gpu']));
  }
  const rememberedInitialUrl = String(profile.initialUrl || '');
  const rememberedRestoreLastSession = profile.restoreLastSession === true;
  // Internal restarts should restore existing tabs without reopening initialUrl.
  if (options.reopenInitialUrl !== true) {
    profile.initialUrl = '';
    profile.restoreLastSession = true;
  }
  const bounds = { ...state.bounds };
  await runtime.stop(id, { timeoutMs: 3000 });
  const runtimeState = await runtime.launchProfile(profile, bounds);
  const restartedInstance = runtime.instances.get(id);
  if (restartedInstance?.profile) {
    restartedInstance.profile.initialUrl = rememberedInitialUrl;
    restartedInstance.profile.restoreLastSession = rememberedRestoreLastSession;
  }
  return runtimeState;
}

async function preserveChromiumSession(runtime, id, instance, preCloseSnapshot, stableSnapshot) {
  const postCloseSnapshot = await waitForSettledChromiumSession(instance.paths, 3000);
  if (snapshotHasRestorableSession(postCloseSnapshot)) {
    persistStableChromiumSession(instance.paths, postCloseSnapshot, runtime.logger);
    return;
  }
  const recoverySnapshot = snapshotHasRestorableSession(preCloseSnapshot) ? preCloseSnapshot : stableSnapshot;
  if (recoverySnapshot && restoreChromiumSessionFiles(recoverySnapshot, runtime.logger)) {
    persistStableChromiumSession(instance.paths, recoverySnapshot, runtime.logger);
    runtime.logger?.warn?.(`[ChromiumRuntime] ${id} 退出结果无活动标签，已恢复稳定 Session`);
  }
}

module.exports = {
  cleanupFailedChromiumLaunch,
  restartChromiumProfile,
  stopChromiumProfile,
  terminateProcessTree,
  waitForChildExit,
  waitForSettledChromiumSession,
};

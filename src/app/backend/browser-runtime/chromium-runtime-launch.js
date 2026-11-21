'use strict';

const crypto = require('crypto');
const { ChromiumCommandClient, createPipeName } = require('./chromium-command-client');
const { ChromiumLaunchResources } = require('./chromium-launch-resources');
const { launchChromium } = require('./chromium-launcher');
const { snapshotAppliedChromiumProfile } = require('./chromium-profile-snapshot');
const { prepareChromiumProfileEnvironment } = require('./chromium-runtime-environment');
const { cleanupFailedChromiumLaunch, hasChromiumExited } = require('./chromium-runtime-process');
const { createChromiumPerformanceSpan } = require('./chromium-performance');
const { logChromiumFailure } = require('./chromium-runtime-recovery');
const { normalizeBounds, RUNTIME_STATUS, RUNTIME_TYPES } = require('./runtime-types');

function prepareProfileLaunch(runtime, profileId, rawProfile, rawBounds, performanceSpan) {
  const existing = runtime.instances.get(profileId);
  if (!hasChromiumExited(existing?.child)) {
    const error = /** @type {Error & {code?: string}} */ (new Error(`Chromium Profile ${profileId} 仍在运行`));
    error.code = 'CHROMIUM_PROFILE_ALREADY_RUNNING';
    throw error;
  }
  const bounds = normalizeBounds(rawBounds);
  performanceSpan?.mark('boundsNormalize');
  const paths = runtime.store.ensureProfile({ ...rawProfile, profileId, runtimeType: RUNTIME_TYPES.CHROMIUM });
  performanceSpan?.mark('profileStorage');
  const runtimeProfileId = String(paths.id || '').trim();
  runtime.store.acquireLock(profileId, { runtimeType: RUNTIME_TYPES.CHROMIUM });
  performanceSpan?.mark('profileLock');
  runtime.stateStore.createState(profileId, RUNTIME_TYPES.CHROMIUM, { bounds, status: RUNTIME_STATUS.STARTING, startedAt: Date.now() });
  performanceSpan?.mark('stateCreate');
  return {
    profileId,
    profile: { ...rawProfile, profileId },
    paths,
    runtimeProfileId,
    bounds,
    resources: new ChromiumLaunchResources(paths, runtime.windowBridge, runtime.logger),
    performanceSpan,
  };
}

async function createProfileInstance(runtime, context) {
  const launchProfile = await prepareChromiumProfileEnvironment(context);
  const parentWindow = runtime.getParentWindow?.();
  if (!parentWindow || parentWindow.isDestroyed?.()) throw new Error('Electron 主窗口不可用');
  const hostHwnd = runtime.windowBridge.createHostWindow({
    parentHwnd: parentWindow.getNativeWindowHandle(),
    ...context.bounds,
  });
  context.resources.hostHwnd = hostHwnd;
  runtime.windowBridge.hideHostWindow(hostHwnd);
  context.performanceSpan?.mark('hostWindow');
  const pipeName = createPipeName(context.profileId);
  const launchToken = crypto.randomBytes(32).toString('hex');
  const commandClient = new ChromiumCommandClient({
    profileId: context.runtimeProfileId, pipeName, launchToken, logger: runtime.logger,
  });
  context.resources.commandClient = commandClient;
  await commandClient.listen();
  context.performanceSpan?.mark('pipeListen');
  runtime.stateStore.transition(context.profileId, RUNTIME_STATUS.WAITING_PIPE, { hostHwnd, pipeName });
  const launched = await launchChromium({
    ...context,
    profile: launchProfile,
    hostHwnd,
    pipeName,
    launchToken,
    ...runtime.launchOptions,
    executablePath: context.profile.executablePath,
    logger: runtime.logger,
  });
  context.resources.child = launched.child;
  context.performanceSpan?.mark('processLaunch');
  const instance = recordProfileInstance(runtime, context, parentWindow, commandClient, launched);
  runtime.bindInstance(context.profileId, instance);
  return instance;
}

function recordProfileInstance(runtime, context, parentWindow, commandClient, launched) {
  const { child } = launched;
  commandClient.setExpectedPid(child.pid);
  const instance = {
    profile: context.profile,
    appliedProfile: snapshotAppliedChromiumProfile(context.profile, launched.args),
    paths: context.paths,
    child,
    commandClient,
    resources: context.resources,
    parentWindow,
    runtimeProfileId: context.runtimeProfileId,
    expectedExit: false,
    autoRecoveredAt: runtime.crashRecoveryAttempts.get(context.profileId)?.task ? Date.now() : 0,
    launchFailure: null,
    diagnostics: launched.diagnostics,
    monitor: null,
    parentFocusHandler: null,
    parentFocusRaiseTimers: new Set(),
    performanceSpan: context.performanceSpan,
  };
  runtime.instances.set(context.profileId, instance);
  runtime.stateStore.patchState(context.profileId, { pid: child.pid });
  return instance;
}

async function showExistingProfile(runtime, profileId, rawBounds) {
  const span = createChromiumPerformanceSpan(runtime.logger, 'runtime-show');
  try {
    await runtime.resize(profileId, rawBounds);
    span.mark('resize');
    await runtime.show(profileId);
    span.mark('show');
    span.finish();
    return runtime.getState(profileId);
  } catch (error) {
    span.fail(error);
    throw error;
  }
}

function stopOwnsLaunchCleanup(runtime, profileId, error) {
  const state = runtime.stateStore.getState(profileId);
  return error?.code === 'CHROMIUM_LAUNCH_CANCELLED'
    && [RUNTIME_STATUS.STOPPING, RUNTIME_STATUS.STOPPED].includes(state?.status);
}

async function cleanupLaunchFailure(runtime, profileId, context, error, span) {
  if (!stopOwnsLaunchCleanup(runtime, profileId, error)) {
    await cleanupFailedChromiumLaunch(runtime, profileId, {
      ...context,
      error,
    });
    span.mark('failureCleanup');
  }
}

async function launchChromiumProfile(runtime, rawProfile = {}, rawBounds = {}) {
  const profileId = String(rawProfile.profileId || rawProfile.id || '').trim();
  if (!profileId) throw new Error('缺少 Profile ID');
  if (runtime.isProfileRunning(profileId)) {
    return showExistingProfile(runtime, profileId, rawBounds);
  }
  const span = createChromiumPerformanceSpan(runtime.logger, 'runtime-launch');
  let context;
  try {
    context = runtime.prepareProfileLaunch(profileId, rawProfile, rawBounds, span);
    const instance = await runtime.createProfileInstance(context);
    await runtime.completeProfileLaunch(profileId, instance, context.bounds);
    span.finish();
    return runtime.getState(profileId);
  } catch (error) {
    if (error?.code !== 'CHROMIUM_LAUNCH_CANCELLED' && !runtime.crashRecoveryAttempts?.get(profileId)?.task) {
      logChromiumFailure(runtime, '浏览器启动失败', profileId, runtime.stateStore.getState(profileId),
        runtime.instances?.get(profileId), error);
    }
    if (context) await cleanupLaunchFailure(runtime, profileId, context, error, span);
    span.fail(error);
    throw error;
  }
}

module.exports = { createProfileInstance, launchChromiumProfile, prepareProfileLaunch };

const crypto = require('crypto');
const { ChromiumLaunchResources } = require('./chromium-launch-resources');
const { RuntimeStateStore, cloneRuntimeState } = require('./runtime-state-store');
const { ChromiumSessionImporter } = require('./chromium-session-importer');
const { updateProfileConfiguration } = require('./chromium-profile-configuration');
const path = require('path');
const { EventEmitter } = require('events');
const { ChromiumCommandClient, createPipeName } = require('./chromium-command-client');
const { ChromiumHealthMonitor } = require('./chromium-health');
const { launchChromium } = require('./chromium-launcher');
const { assertActiveChromiumLaunch, normalizeBounds, RUNTIME_STATUS, RUNTIME_TYPES } = require('./runtime-types');
const { restartChromiumProfile, stopChromiumProfile } = require('./chromium-runtime-process');
const { launchChromiumProfile } = require('./chromium-runtime-launch');
const { bindChromiumProcessFailure } = require('./chromium-process-diagnostics');
const { snapshotAppliedChromiumProfile } = require('./chromium-profile-snapshot');
const { attachChildWindowWithRetry } = require('./chromium-window-attachment');
const { dispatchRuntimeInput, dispatchRuntimeInputByProcessId } = require('./runtime-input');
const { dispatchRuntimeAutomationByProcessId } = require('./runtime-automation');
const { waitForBrowserWindow } = require('./chromium-handshake-waiter');
const { startChromiumPreflightWarmup } = require('./chromium-preflight-warmup');
const {
  prepareChromiumProfileEnvironment,
  refreshChromiumEnvironmentProfile,
} = require('./chromium-runtime-environment');

class ChromiumRuntime extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = options.logger || console;
    this.store = options.store;
    this.stateStore = options.stateStore || new RuntimeStateStore((state) => { this.emit('state-changed', state); });
    this.windowBridge = options.windowBridge;
    this.getParentWindow = options.getParentWindow;
    this.launchOptions = { resourcesPath: options.resourcesPath, chromiumLogPath: options.chromiumLogPath, chromiumDiagnosticDir: options.chromiumDiagnosticDir, chromiumUserDataDir: options.chromiumUserDataDir, appVersion: options.appVersion };
    this.instances = new Map();
    this.sessionImporter = new ChromiumSessionImporter({
      logger: this.logger, getCommandClient: (profileId) => this.getReadyInstance(profileId).commandClient,
    });
    // 同一 Profile 的重启、导航、会话注入和刷新必须排队，避免误判运行状态。
    this.profileOperationQueues = new Map();
  }

  enqueueProfileOperation(profileId, operation) {
    const id = String(profileId || '').trim();
    const previous = this.profileOperationQueues.get(id) || Promise.resolve();
    const queued = previous.catch(() => {}).then(operation);
    let tracked = null;
    tracked = queued.finally(() => {
      if (this.profileOperationQueues.get(id) === tracked) {
        this.profileOperationQueues.delete(id);
      }
    });
    this.profileOperationQueues.set(id, tracked);
    return tracked;
  }

  /** @param {Record<string, any>} [rawProfile] */
  async launchProfile(rawProfile = {}, rawBounds = {}) {
    return launchChromiumProfile(this, rawProfile, rawBounds);
  }

  prewarm() {
    return startChromiumPreflightWarmup({
      ...this.launchOptions,
      cacheFile: path.join(this.store.rootDir, '.chromium-sandbox-access.json'),
      logger: this.logger,
    });
  }

  isProfileRunning(profileId) {
    return ['ready', 'hidden'].includes(this.stateStore.getState(profileId)?.status);
  }

  prepareProfileLaunch(profileId, rawProfile, rawBounds, performanceSpan) {
    const existing = this.instances.get(profileId);
    if (existing?.child?.exitCode === null) {
      const error = /** @type {Error & {code?: string}} */ (new Error(`Chromium Profile ${profileId} 仍在运行`));
      error.code = 'CHROMIUM_PROFILE_ALREADY_RUNNING';
      throw error;
    }
    const bounds = normalizeBounds(rawBounds);
    performanceSpan?.mark('boundsNormalize');
    const paths = this.store.ensureProfile({ ...rawProfile, profileId, runtimeType: RUNTIME_TYPES.CHROMIUM });
    performanceSpan?.mark('profileStorage');
    const runtimeProfileId = String(paths.id || '').trim();
    this.store.acquireLock(profileId, { runtimeType: RUNTIME_TYPES.CHROMIUM });
    performanceSpan?.mark('profileLock');
    this.stateStore.createState(profileId, RUNTIME_TYPES.CHROMIUM, { bounds, status: RUNTIME_STATUS.STARTING, startedAt: Date.now() });
    performanceSpan?.mark('stateCreate');
    return {
      profileId,
      profile: { ...rawProfile, profileId },
      paths,
      runtimeProfileId,
      bounds,
      resources: new ChromiumLaunchResources(paths, this.windowBridge, this.logger),
      performanceSpan,
    };
  }

  async createProfileInstance(context) {
    const launchProfile = await prepareChromiumProfileEnvironment(context);
    const parentWindow = this.getParentWindow?.();
    if (!parentWindow || parentWindow.isDestroyed?.()) throw new Error('Electron 主窗口不可用');
    const hostHwnd = this.windowBridge.createHostWindow({
      parentHwnd: parentWindow.getNativeWindowHandle(),
      ...context.bounds,
    });
    context.resources.hostHwnd = hostHwnd;
    this.windowBridge.hideHostWindow(hostHwnd);
    context.performanceSpan?.mark('hostWindow');
    const pipeName = createPipeName(context.profileId);
    const launchToken = crypto.randomBytes(32).toString('hex');
    const commandClient = new ChromiumCommandClient({
      profileId: context.runtimeProfileId, pipeName, launchToken, logger: this.logger,
    });
    context.resources.commandClient = commandClient;
    await commandClient.listen();
    context.performanceSpan?.mark('pipeListen');
    this.stateStore.transition(context.profileId, RUNTIME_STATUS.WAITING_PIPE, { hostHwnd, pipeName });
    const launched = await launchChromium({
      ...context,
      profile: launchProfile,
      hostHwnd,
      pipeName,
      launchToken,
      ...this.launchOptions,
      executablePath: context.profile.executablePath,
      logger: this.logger,
    });
    context.resources.child = launched.child;
    context.performanceSpan?.mark('processLaunch');
    const instance = this.recordProfileInstance(context, parentWindow, commandClient, launched);
    this.bindInstance(context.profileId, instance);
    return instance;
  }

  recordProfileInstance(context, parentWindow, commandClient, launched) {
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
      launchFailure: null,
      diagnostics: launched.diagnostics,
      monitor: null,
      parentFocusHandler: null,
      parentFocusRaiseTimers: new Set(),
      performanceSpan: context.performanceSpan,
    };
    this.instances.set(context.profileId, instance);
    this.stateStore.patchState(context.profileId, { pid: child.pid });
    return instance;
  }

  async completeProfileLaunch(profileId, instance, bounds) {
    const browserHwnd = await this.waitForBrowserWindow(profileId, instance);
    instance.performanceSpan?.mark('pipeHandshake');
    assertActiveChromiumLaunch(this.instances.get(String(profileId)) === instance, this.stateStore.getState(profileId)?.status);
    this.assertCompleteHandshake(profileId, browserHwnd);
    await this.attachProfileWindow(profileId, instance, browserHwnd, bounds);
    instance.performanceSpan?.mark('windowAttach');
    instance.monitor = new ChromiumHealthMonitor({
      isWindowAlive: (hwnd) => this.windowBridge.isWindowAlive(hwnd),
      onFailure: (error) => this.markCrashed(profileId, error),
    });
    instance.monitor.start(() => this.stateStore.getState(profileId));
    this.bindParentWindowFocus(profileId, instance);
    instance.performanceSpan?.mark('runtimeFinalize');
  }

  assertCompleteHandshake(profileId, browserHwnd) {
    const prototypeMode = String(process.env.AI_FREE_CHROMIUM_HANDSHAKE || '').toLowerCase() === 'prototype';
    const state = this.stateStore.getState(profileId);
    if (prototypeMode || (state?.bridgeConnected && state?.sessionId && browserHwnd)) return;
    const error = /** @type {Error & {code?: string}} */ (new Error('AI-FREE Chromium Fork 握手状态不完整'));
    error.code = 'CHROMIUM_HANDSHAKE_INCOMPLETE';
    throw error;
  }

  async attachProfileWindow(profileId, instance, browserHwnd, bounds) {
    assertActiveChromiumLaunch(this.instances.get(String(profileId)) === instance, this.stateStore.getState(profileId)?.status);
    this.stateStore.transition(profileId, RUNTIME_STATUS.ATTACHING, { browserHwnd });
    instance.resources.browserHwnd = browserHwnd;
    const attached = await attachChildWindowWithRetry(this.windowBridge, {
      hostHwnd: instance.resources.hostHwnd,
      childHwnd: browserHwnd,
      childPid: instance.child.pid,
      title: 'AI-FREE',
    }, { logger: this.logger });
    if (!attached) {
      const error = /** @type {Error & {code?: string}} */ (new Error('外部浏览器未能嵌入 AI-FREE 软件窗口'));
      error.code = 'CHROMIUM_HWND_ATTACH_FAILED';
      throw error;
    }
    this.windowBridge.setChildWindowTitle(browserHwnd, 'AI-FREE');
    this.windowBridge.setHostBounds(instance.resources.hostHwnd, bounds);
    this.windowBridge.showHostWindow(instance.resources.hostHwnd);
    this.stateStore.transition(profileId, RUNTIME_STATUS.READY, {
      productName: 'AI-FREE', embedded: true, lastHeartbeatAt: Date.now(),
    });
  }

  bindInstance(profileId, instance) {
    instance.commandClient.on('hello', (message) => {
      this.stateStore.patchState(profileId, { bridgeConnected: true, sessionId: message.sessionId, lastHeartbeatAt: Date.now() });
    });
    instance.commandClient.on('heartbeat', () => this.stateStore.patchState(profileId, { lastHeartbeatAt: Date.now() }));
    // Keep the transport-only ASCII ID out of application-facing runtime events.
    instance.commandClient.on('event', (message) => this.emit('runtime-event', { ...message, profileId }));
    bindChromiumProcessFailure(instance, (error) => this.markCrashed(profileId, error),
      () => {
        instance.monitor?.stop();
        this.unbindParentWindowFocus(instance);
        void instance.resources?.dispose({ processExited: true }).catch(() => {
          this.logger?.warn?.('[ChromiumRuntime] 浏览器退出后的资源释放失败');
        });
      });
  }

  bindParentWindowFocus(profileId, instance) {
    const parentWindow = instance?.parentWindow;
    if (!parentWindow?.on || instance.parentFocusHandler) return;
    if (!(instance.parentFocusRaiseTimers instanceof Set)) {
      instance.parentFocusRaiseTimers = new Set();
    }
    const raiseEmbeddedHost = () => {
        const state = this.stateStore.getState(profileId);
        if (state?.status !== RUNTIME_STATUS.READY || !state.hostHwnd) return;
        try {
          // This only repairs sibling Z-order. It deliberately avoids bounds
          // changes, redraws and activation, so Chromium keeps its current
          // pixels and keyboard focus without flashing.
          this.windowBridge.raiseHostWindow(state.hostHwnd);
        } catch (error) {
          this.logger?.warn?.(`[ChromiumRuntime] 恢复嵌入窗口 Z-order 失败: ${error.message}`);
        }
    };
    const restoreEmbeddedHostZOrder = () => {
      this.clearParentFocusRaiseTimers(instance);
      // Electron can raise its renderer sibling once more during the first
      // compositor/layout frames after a background -> foreground switch.
      // Raise Chromium immediately for the first click, then reassert only
      // Z-order at two bounded checkpoints after Electron has settled.
      raiseEmbeddedHost();
      for (const delayMs of [32, 160]) {
        const timer = setTimeout(() => {
          instance.parentFocusRaiseTimers?.delete(timer);
          raiseEmbeddedHost();
        }, delayMs);
        timer.unref?.();
        instance.parentFocusRaiseTimers.add(timer);
      }
    };
    instance.parentFocusHandler = restoreEmbeddedHostZOrder;
    parentWindow.on('focus', restoreEmbeddedHostZOrder);
  }

  clearParentFocusRaiseTimers(instance) {
    if (!instance?.parentFocusRaiseTimers) return;
    for (const timer of instance.parentFocusRaiseTimers) clearTimeout(timer);
    instance.parentFocusRaiseTimers.clear();
  }

  unbindParentWindowFocus(instance) {
    if (!instance?.parentFocusHandler) return;
    try { instance.parentWindow?.off?.('focus', instance.parentFocusHandler); } catch (_) {}
    instance.parentFocusHandler = null;
    this.clearParentFocusRaiseTimers(instance);
  }

  async waitForBrowserWindow(profileId, instance) {
    return waitForBrowserWindow(this, profileId, instance);
  }

  async show(profileId) {
    const state = this.stateStore.getState(profileId);
    if (!state?.hostHwnd) return state;
    this.windowBridge.setHostBounds(state.hostHwnd, state.bounds);
    this.windowBridge.showHostWindow(state.hostHwnd);
    if (state.status === RUNTIME_STATUS.HIDDEN) this.stateStore.transition(profileId, RUNTIME_STATUS.READY);
    return this.getState(profileId);
  }
  async hide(profileId) {
    const state = this.stateStore.getState(profileId);
    if (!state?.hostHwnd) return state;
    this.windowBridge.hideHostWindow(state.hostHwnd);
    if (state.status === RUNTIME_STATUS.READY) this.stateStore.transition(profileId, RUNTIME_STATUS.HIDDEN);
    return this.getState(profileId);
  }
  async resize(profileId, rawBounds) {
    const state = this.stateStore.getState(profileId);
    if (!state) return null;
    const bounds = normalizeBounds(rawBounds);
    if (state.hostHwnd) this.windowBridge.setHostBounds(state.hostHwnd, bounds);
    this.stateStore.patchState(profileId, { bounds });
    return this.getState(profileId);
  }
  async focus(profileId) {
    const state = this.stateStore.getState(profileId);
    return state?.browserHwnd ? this.windowBridge.focusChildWindow(state.browserHwnd) : false;
  }
  releaseFocus(profileId) { const state = this.stateStore.getState(profileId); return state?.browserHwnd ? this.windowBridge.releaseChildWindowFocus(state.browserHwnd) : false; }
  /** @returns {ReturnType<typeof import('./runtime-types').createRuntimeState> | null} */
  getState(profileId) {
    const state = this.stateStore.getState(profileId);
    return state ? cloneRuntimeState(state) : null;
  }
  getReadyInstance(profileId) {
    const id = String(profileId || '').trim();
    const state = this.stateStore.getState(id);
    const instance = this.instances.get(id);
    if (!instance || !state || ![RUNTIME_STATUS.READY, RUNTIME_STATUS.HIDDEN].includes(state.status)) {
      /** @type {Error & {code?: string}} */
      const error = new Error(`Chromium Profile ${id || '<empty>'} 尚未就绪`);
      error.code = 'CHROMIUM_RUNTIME_NOT_READY';
      throw error;
    }
    return instance;
  }

  async reload(profileId) {
    return this.enqueueProfileOperation(profileId, () => this.reloadNow(profileId));
  }

  async reloadNow(profileId) {
    try {
      return await this.getReadyInstance(profileId).commandClient.send('reload');
    } catch (error) {
      if (error?.code !== 'RUNTIME_COMMAND_TIMEOUT') throw error;
      // The reload command has already reached Chromium. Its response is sent
      // only after the page finishes loading, so a slow site can exceed the
      // bridge deadline even though the refresh itself is proceeding normally.
      this.logger?.warn?.(
        `[ChromiumRuntime] reload ${profileId}: 页面仍在加载，忽略 Runtime Bridge 回包超时`,
      );
      return {
        ok: true,
        result: {
          pending: true,
          timedOut: true,
          message: '页面仍在加载',
        },
      };
    }
  }
  async navigate(profileId, url) {
    return this.enqueueProfileOperation(profileId, () => (
      this.getReadyInstance(profileId).commandClient.send('navigate', { url: String(url || '') }, { timeoutMs: 30000 })
    ));
  }

  async openTabs(profileId, urls = []) {
    return this.enqueueProfileOperation(profileId, () => this.getReadyInstance(profileId).commandClient.send(
      'open-tabs', { urls: Array.isArray(urls) ? urls : [] }, { timeoutMs: 30000 }));
  }

  async listTabs(profileId) {
    return this.enqueueProfileOperation(profileId, () => (
      this.getReadyInstance(profileId).commandClient.send('list-tabs')
    ));
  }

  async dispatchInput(profileId, source) { return dispatchRuntimeInput(this, profileId, source); }

  async dispatchInputByProcessId(processId, source) {
    return dispatchRuntimeInputByProcessId(this, processId, source);
  }

  async dispatchAutomationByProcessId(processId, command, source) {
    return dispatchRuntimeAutomationByProcessId(this, processId, command, source);
  }

  async importSession(profileId, rawSession = {}) {
    return this.enqueueProfileOperation(profileId, () => this.sessionImporter.importSession(profileId, rawSession));
  }

  async setCookies(profileId, rawCookies = []) {
    return this.enqueueProfileOperation(profileId, () => this.sessionImporter.setCookies(profileId, rawCookies));
  }

  async restart(profileId, options = {}) {
    return this.enqueueProfileOperation(profileId, () => this.restartNow(profileId, options));
  }

  async clearData(profileId) {
    return this.enqueueProfileOperation(profileId, () => this.clearDataNow(profileId));
  }

  async clearDataNow(profileId) {
    const id = String(profileId);
    const instance = this.instances.get(id);
    const state = this.stateStore.getState(id);
    if (!instance || !state) throw new Error(`Chromium Profile ${id} 不存在`);
    if (typeof this.store.clearBrowserData !== 'function') {
      throw new Error('Chromium Profile 存储不支持清空浏览器数据');
    }
    const profile = {
      ...instance.profile,
      initialUrl: String(instance.profile.initialUrl || instance.profile.restoreFallbackUrl || ''),
      restoreLastSession: false,
    };
    const bounds = { ...state.bounds };
    await this.stop(id, { timeoutMs: 5000, preserveSession: false });
    this.store.clearBrowserData(id);
    return this.launchProfile(profile, bounds);
  }

  async refreshEnvironmentProfile(profileId, update) {
    return refreshChromiumEnvironmentProfile(this, profileId, update);
  }

  updateProfileConfiguration(profileId, update, options) {
    return updateProfileConfiguration(this, profileId, update, options);
  }

  async restartNow(profileId, options = {}) {
    return restartChromiumProfile(this, profileId, options);
  }

  async stop(profileId, options = {}) {
    return stopChromiumProfile(this, profileId, options);
  }

  async stopAll(options = {}) { return Promise.all(this.stateStore.listStates().filter((s) => s.runtimeType === RUNTIME_TYPES.CHROMIUM).map((s) => this.stop(s.profileId, options))); }

  markCrashed(profileId, error) {
    const state = this.stateStore.getState(profileId);
    if (!state || [RUNTIME_STATUS.STOPPED, RUNTIME_STATUS.STOPPING, RUNTIME_STATUS.CRASHED].includes(state.status)) return;
    try { this.windowBridge.hideHostWindow(state.hostHwnd); } catch (_) {}
    this.stateStore.patchState(profileId, { status: RUNTIME_STATUS.CRASHED, browserHwnd: null, bridgeConnected: false, embedded: false, lastError: error, crashCount: Number(state.crashCount || 0) + 1 });
    this.emit('crashed', this.getState(profileId));
  }

}

module.exports = { ChromiumRuntime };

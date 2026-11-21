const { RuntimeStateStore, cloneRuntimeState } = require('./runtime-state-store');
const { ChromiumSessionImporter } = require('./chromium-session-importer');
const { updateProfileConfiguration } = require('./chromium-profile-configuration');
const path = require('path');
const { EventEmitter } = require('events');
const { ChromiumHealthMonitor } = require('./chromium-health');
const { assertActiveChromiumLaunch, normalizeBounds, RUNTIME_STATUS, RUNTIME_TYPES } = require('./runtime-types');
const { restartChromiumProfile, stopChromiumProfile } = require('./chromium-runtime-process');
const { createProfileInstance, launchChromiumProfile, prepareProfileLaunch } = require('./chromium-runtime-launch');
const { bindChromiumProcessFailure } = require('./chromium-process-diagnostics');
const { cancelChromiumRecovery, markChromiumCrashed } = require('./chromium-runtime-recovery');
const { attachChildWindowWithRetry } = require('./chromium-window-attachment');
const { dispatchRuntimeInput, dispatchRuntimeInputByProcessId } = require('./runtime-input');
const { dispatchRuntimeAutomationByProcessId } = require('./runtime-automation');
const { waitForBrowserWindow } = require('./chromium-handshake-waiter');
const { startChromiumPreflightWarmup } = require('./chromium-preflight-warmup');
const { refreshChromiumEnvironmentProfile } = require('./chromium-runtime-environment');

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
    /** @type {Map<string, {visible: boolean, cancelled: boolean, task?: Promise<void>}>} */
    this.crashRecoveryAttempts = new Map();
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
    return prepareProfileLaunch(this, profileId, rawProfile, rawBounds, performanceSpan);
  }

  async createProfileInstance(context) {
    return createProfileInstance(this, context);
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
      onFailure: (error) => this.markCrashed(profileId, error, instance),
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
    if (instance.launchFailure) throw instance.launchFailure;
    this.windowBridge.setChildWindowTitle(browserHwnd, 'AI-FREE');
    this.windowBridge.setHostBounds(instance.resources.hostHwnd, bounds);
    const recovery = this.crashRecoveryAttempts.get(profileId);
    const hidden = recovery && (!recovery.visible || recovery.cancelled);
    if (!hidden) this.windowBridge.showHostWindow(instance.resources.hostHwnd);
    this.stateStore.transition(profileId, hidden ? RUNTIME_STATUS.HIDDEN : RUNTIME_STATUS.READY, {
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
    bindChromiumProcessFailure(instance, (error) => this.markCrashed(profileId, error, instance),
      () => {
        instance.monitor?.stop();
        this.unbindParentWindowFocus(instance);
        void instance.resources?.dispose({ processExited: true }).catch(() => {
          this.logger?.warn?.('[ChromiumRuntime] 浏览器退出后的资源释放失败');
        });
      }, () => this.isProfileRunning(profileId));
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
    const recovery = this.crashRecoveryAttempts.get(String(profileId));
    if (recovery) recovery.visible = true;
    const state = this.stateStore.getState(profileId);
    if (!state?.hostHwnd || (recovery && (!this.isProfileRunning(profileId) || recovery.cancelled))) return state;
    this.windowBridge.setHostBounds(state.hostHwnd, state.bounds);
    this.windowBridge.showHostWindow(state.hostHwnd);
    if (state.status === RUNTIME_STATUS.HIDDEN) this.stateStore.transition(profileId, RUNTIME_STATUS.READY);
    return this.getState(profileId);
  }
  async hide(profileId) {
    const recovery = this.crashRecoveryAttempts.get(String(profileId));
    if (recovery) recovery.visible = false;
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

  async openForegroundTab(profileId, url, previousUrl = '') {
    return this.enqueueProfileOperation(profileId, async () => {
      const { commandClient } = this.getReadyInstance(profileId);
      try {
        return await commandClient.send('open-destination-tab', {
          url, ...(previousUrl && { previousUrl }),
        }, { timeoutMs: 30000 });
      } catch (error) {
        if (error?.code !== 'COMMAND_NOT_ALLOWED') throw error;
        throw Object.assign(new Error('当前 Chromium 内核不支持教程和商城标签复用，请更新浏览器内核'), {
          code: 'BROWSER_RUNTIME_UPDATE_REQUIRED',
        });
      }
    });
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

  async dispatchAutomationByProcessId(processId, command, source, options = {}) {
    return dispatchRuntimeAutomationByProcessId(this, processId, command, source, options);
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
    const pending = cancelChromiumRecovery(this.crashRecoveryAttempts, String(profileId));
    if (pending) await pending.catch(() => {});  // The recovery owner logs failures; always finish closing.
    return stopChromiumProfile(this, profileId, options);
  }

  async stopAll(options = {}) { return Promise.all(this.stateStore.listStates().filter((s) => s.runtimeType === RUNTIME_TYPES.CHROMIUM).map((s) => this.stop(s.profileId, options))); }

  markCrashed(profileId, error, instance = this.instances.get(profileId)) {
    markChromiumCrashed(this, profileId, error, instance);
  }

}

module.exports = { ChromiumRuntime };

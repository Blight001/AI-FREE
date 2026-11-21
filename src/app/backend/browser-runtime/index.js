const path = require('path');
const { ChromiumRuntime } = require('./chromium-runtime');
const { ChromiumWindowBridge } = require('./chromium-window-bridge');
const { ProfileRuntimeStore } = require('./profile-runtime-store');
const { cleanupLocalModels } = require('./chromium-local-model-policy');
const { RUNTIME_TYPES } = require('./runtime-types');
const { selectRuntimeFilesByProcessId } = require('./runtime-file-selection');

class BrowserRuntimeManager {
  constructor(options = {}) {
    const userDataDir = options.userDataDir;
    this.logger = options.logger || console;
    this.sandboxDir = options.sandboxDir ? path.resolve(String(options.sandboxDir)) : '';
    this.store = options.store || new ProfileRuntimeStore({
      rootDir: path.join(userDataDir, 'chromium-profiles'),
      downloadsDir: this.sandboxDir,
      logger: this.logger,
    });
    this.localModelCleanup = cleanupLocalModels(this.store.rootDir, this.logger);
    this.windowBridge = options.windowBridge || new ChromiumWindowBridge({
      logger: this.logger,
      resourcesPath: options.resourcesPath,
    });
    this.chromium = options.chromiumRuntime || new ChromiumRuntime({
      logger: this.logger,
      store: this.store,
      windowBridge: this.windowBridge,
      getParentWindow: options.getParentWindow,
      resourcesPath: options.resourcesPath,
      chromiumLogPath: options.chromiumLogPath || path.join(userDataDir, 'logs', 'chromium-runtime.log'),
      chromiumDiagnosticDir: options.chromiumDiagnosticDir || path.join(userDataDir, 'diagnostics'),
      chromiumUserDataDir: userDataDir,
      appVersion: options.appVersion,
    });
  }

  async launchProfile(profile, bounds) { return this.chromium.launchProfile(profile, bounds); }
  async prewarmChromium() { return this.chromium.prewarm(); }
  async show(profileId, type) { return this.chromium.show(profileId); }
  async hide(profileId, type) { return this.chromium.hide(profileId); }
  async resize(profileId, type, bounds) { return this.chromium.resize(profileId, bounds); }
  async focus(profileId, type) { return this.chromium.focus(profileId); }
  releaseFocus(profileId, type) { return this.chromium.releaseFocus(profileId); }
  async reload(profileId, type) { return this.chromium.reload(profileId); }
  async navigate(profileId, type, url) { return this.chromium.navigate?.(profileId, url); }
  async openTabs(profileId, type, urls) { return this.chromium.openTabs?.(profileId, urls); }
  async openForegroundTab(profileId, type, url, previousUrl) {
    return this.chromium.openForegroundTab(profileId, url, previousUrl);
  }
  async listTabs(profileId, type) { return this.chromium.listTabs?.(profileId); }
  async dispatchInput(profileId, input) { return this.chromium.dispatchInput(profileId, input); }
  async dispatchInputByProcessId(processId, input) {
    return this.chromium.dispatchInputByProcessId(processId, input);
  }
  async dispatchAutomationByProcessId(processId, command, input, options = {}) {
    return this.chromium.dispatchAutomationByProcessId(processId, command, input, options);
  }
  async selectFilesByProcessId(processId, selection, options = {}) {
    return selectRuntimeFilesByProcessId(this.chromium, processId, selection, { ...options, sandboxDir: this.sandboxDir });
  }
  async importSession(profileId, sessionData) { return this.chromium.importSession(profileId, sessionData); }
  async setCookies(profileId, cookies) { return this.chromium.setCookies(profileId, cookies); }
  async restart(profileId, options) { return this.chromium.restart(profileId, options); }
  async refreshEnvironmentProfile(profileId, update) {
    return this.chromium.refreshEnvironmentProfile(profileId, update);
  }
  updateProfileConfiguration(profileId, update, options) {
    return this.chromium.updateProfileConfiguration(profileId, update, options);
  }
  async clearData(profileId) { return this.chromium.clearData(profileId); }
  async stop(profileId, type, options) { return this.chromium.stop(profileId, options); }
  async stopAll(options) { return this.chromium.stopAll(options); }
  getState(profileId) { return this.chromium.getState(profileId); }
  listStates() { return this.chromium.stateStore.listStates(); }
  isManagedBrowserProcess(processId) {
    const pid = Number(processId || 0) || 0;
    if (!pid) return false;
    for (const instance of this.chromium.instances.values()) {
      if (Number(instance?.child?.pid || 0) === pid && instance.child.exitCode === null) {
        return true;
      }
    }
    return false;
  }
  deleteProfile(profileId) {
    const deleted = this.store.deleteProfile(profileId);
    this.chromium.stateStore.clearState(profileId);
    return deleted;
  }
  async deleteProfileAsync(profileId) {
    if (typeof this.store.deleteProfileAsync === 'function') {
      const deleted = await this.store.deleteProfileAsync(profileId);
      this.chromium.stateStore.clearState(profileId);
      return deleted;
    }
    return this.deleteProfile(profileId);
  }
  async waitForLocalModelCleanup() { return this.localModelCleanup; }
  isChromiumAvailable() { return this.windowBridge.isAvailable(); }
}

function createBrowserRuntimeManager(options) { return new BrowserRuntimeManager(options); }

module.exports = { BrowserRuntimeManager, createBrowserRuntimeManager, RUNTIME_TYPES };

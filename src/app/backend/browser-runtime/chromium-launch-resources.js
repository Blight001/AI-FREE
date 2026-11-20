'use strict';

const { removeBrowserEnvironmentExtension } = require('./chromium-browser-environment-extension');

// The launch operation owns this object until recordProfileInstance transfers
// the same object to the instance. Environment files outlive an unconfirmed exit.
class ChromiumLaunchResources {
  constructor(paths, windowBridge, logger) {
    this.paths = paths;
    this.windowBridge = windowBridge;
    this.logger = logger;
    this.hostHwnd = null;
    this.browserHwnd = null;
    this.commandClient = null;
    this.child = null;
    this.proxyAuthBridge = null;
    this.environmentExtensionDir = '';
    this.transportCleanup = null;
    this.environmentCleanup = null;
  }

  async disposeEnvironment() {
    if (!this.environmentCleanup) {
      this.environmentCleanup = (async () => {
        try {
          await this.proxyAuthBridge?.close();
          this.proxyAuthBridge = null;
        }
        finally { removeBrowserEnvironmentExtension(this.paths.root, this.environmentExtensionDir); }
      })().catch((error) => {
        this.environmentCleanup = null;
        throw error;
      });
    }
    return this.environmentCleanup;
  }

  async dispose({ processExited = false } = {}) {
    if (!this.transportCleanup) {
      this.transportCleanup = (async () => {
        try {
          await this.commandClient?.close();
          this.commandClient = null;
        }
        finally { this.releaseWindow(); }
      })().catch((error) => {
        this.transportCleanup = null;
        throw error;
      });
    }
    try { await this.transportCleanup; }
    finally { if (processExited) await this.disposeEnvironment(); }
  }

  releaseWindow() {
    if (!this.hostHwnd) return;
    try {
      if (this.browserHwnd) {
        this.windowBridge.detachChildWindow({ hostHwnd: this.hostHwnd, childHwnd: this.browserHwnd });
      }
    } finally {
      this.windowBridge.destroyHostWindow(this.hostHwnd);
      this.hostHwnd = null;
      this.browserHwnd = null;
    }
  }
}

module.exports = { ChromiumLaunchResources };

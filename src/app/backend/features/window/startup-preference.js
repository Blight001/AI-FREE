'use strict';

const START_MINIMIZED_ARG = '--start-minimized';
const DEFAULT_STARTUP_SETTINGS = Object.freeze({
  openAtLogin: false,
  startMinimized: false,
});

function normalizeStartupSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const hasEnabled = Object.prototype.hasOwnProperty.call(source, 'enabled');
  return {
    openAtLogin: Object.prototype.hasOwnProperty.call(source, 'openAtLogin')
      ? source.openAtLogin === true
      : hasEnabled && source.enabled === true,
    startMinimized: Object.prototype.hasOwnProperty.call(source, 'startMinimized')
      ? source.startMinimized === true
      : hasEnabled && source.enabled === true,
  };
}

function readStartupSettings(readStoreConfigSafe, app) {
  try {
    const store = typeof readStoreConfigSafe === 'function' ? readStoreConfigSafe() : {};
    if (store && Object.prototype.hasOwnProperty.call(store, 'startupSettings')) {
      return normalizeStartupSettings(store.startupSettings);
    }
  } catch (_) {}
  try {
    const settings = app?.getLoginItemSettings?.() || {};
    return {
      openAtLogin: settings.openAtLogin === true,
      startMinimized: settings.wasOpenedAsHidden === true
        || (Array.isArray(settings.args) && settings.args.some((value) => String(value || '').trim() === START_MINIMIZED_ARG)),
    };
  } catch (_) {
    return { ...DEFAULT_STARTUP_SETTINGS };
  }
}

function writeStartupSettings(readStoreConfigSafe, writeStoreConfigSafe, settings) {
  const normalized = normalizeStartupSettings(settings);
  try {
    const currentStore = typeof readStoreConfigSafe === 'function'
      ? (readStoreConfigSafe() || {})
      : {};
    const wrote = typeof writeStoreConfigSafe === 'function'
      && writeStoreConfigSafe({ ...currentStore, startupSettings: normalized });
    return wrote
      ? { ok: true, data: normalized }
      : {
        ok: false,
        error: {
          code: 'STARTUP_SETTINGS_WRITE_FAILED',
          message: '保存开机启动设置失败',
          retryable: true,
        },
      };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'STARTUP_SETTINGS_WRITE_FAILED',
        message: error?.message || String(error),
        retryable: true,
      },
    };
  }
}

function isStartupSupported(app, platform = process.platform) {
  return platform === 'win32' && typeof app?.setLoginItemSettings === 'function';
}

function buildLoginItemArgs(app, settings, { isPackaged = app?.isPackaged !== false } = {}) {
  const args = [];
  if (!isPackaged) {
    const appPath = app?.getAppPath?.();
    if (appPath) args.push(appPath);
  }
  if (settings.startMinimized) args.push(START_MINIMIZED_ARG);
  return args;
}

function applyStartupSettings(app, settings, options = {}) {
  const normalized = normalizeStartupSettings(settings);
  const platform = options.platform || process.platform;
  if (!isStartupSupported(app, platform)) {
    return { ok: true, data: { ...normalized, supported: false } };
  }
  try {
    app.setLoginItemSettings({
      openAtLogin: normalized.openAtLogin,
      path: options.execPath || process.execPath,
      args: buildLoginItemArgs(app, normalized, options),
    });
    return { ok: true, data: { ...normalized, supported: true } };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'STARTUP_SETTINGS_APPLY_FAILED',
        message: error?.message || String(error),
        retryable: true,
      },
    };
  }
}

/**
 * @param {{app?: any, readStoreConfigSafe?: Function, writeStoreConfigSafe?: Function, payload?: object, options?: object}} params
 */
function updateStartupSettings({ app, readStoreConfigSafe, writeStoreConfigSafe, payload, options } = {}) {
  const current = readStartupSettings(readStoreConfigSafe, app);
  const next = normalizeStartupSettings({ ...current, ...(payload || {}) });
  const applied = applyStartupSettings(app, next, options);
  if (!applied.ok) return applied;
  const persisted = writeStartupSettings(readStoreConfigSafe, writeStoreConfigSafe, next);
  if (!persisted.ok) {
    applyStartupSettings(app, current, options);
    return persisted;
  }
  return { ok: true, data: { ...next, supported: applied.data.supported } };
}

function isStartMinimizedArg(argv = process.argv) {
  return Array.isArray(argv) && argv.some((value) => String(value || '').trim() === START_MINIMIZED_ARG);
}

module.exports = {
  DEFAULT_STARTUP_SETTINGS,
  START_MINIMIZED_ARG,
  applyStartupSettings,
  buildLoginItemArgs,
  isStartMinimizedArg,
  isStartupSupported,
  normalizeStartupSettings,
  readStartupSettings,
  updateStartupSettings,
  writeStartupSettings,
};

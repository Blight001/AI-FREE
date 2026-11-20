'use strict';

const os = require('os');
const path = require('path');

function safeAppValue(app, method, ...args) {
  try {
    return typeof app?.[method] === 'function' ? String(app[method](...args) || '').trim() : '';
  } catch (_) {
    return '';
  }
}

function resolveUserDataDir(app) {
  const official = safeAppValue(app, 'getPath', 'userData');
  if (official) return official;

  const appName = safeAppValue(app, 'getName')
    || process.env.ELECTRON_APP_NAME?.trim()
    || process.env.npm_package_name?.trim()
    || 'ai-free';
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(roaming, appName);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), appName);
}

module.exports = { resolveUserDataDir };

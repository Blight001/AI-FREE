'use strict';

const fs = require('fs');
const path = require('path');
const { callOptional, firstText } = require('../../shared/safe-values');

function readPreferences(file, logger) {
  try {
    if (!fs.existsSync(file)) return {};
    const value = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Preferences root is not an object');
    return value;
  } catch (error) {
    callOptional(logger, 'warn', '[ChromiumRuntime] Preferences 读取失败，保留原文件:', error.code || error.name);
    return null;
  }
}

function ensureSection(preferences, key) {
  const value = preferences[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) preferences[key] = {};
  return preferences[key];
}

function acceptedLanguages(profile) {
  return firstText(profile.acceptLanguage, profile.locale).split(',')
    .map((item) => item.split(';')[0].trim()).filter(Boolean).join(',');
}

function applyLocationPermission(state, mode) {
  // Chromium supports both legacy and approximate-location settings.
  const permission = new Map([['allow', 1], ['block', 2], ['ask', 3]]).get(mode);
  if (permission === undefined) return;
  const defaults = ensureSection(state, 'default_content_setting_values');
  defaults.geolocation = permission;
  defaults['geolocation-with-options'] = { approximate: permission, precise: permission };
}

/** @param {Record<string, any>} [profile] */
function applyChromiumSessionStartupPolicy(paths = {}, logger = console, profile = {}) {
  const userDataDir = firstText(paths.chromiumData).trim();
  if (!userDataDir) return false;
  const file = path.join(userDataDir, 'Default', 'Preferences');
  const preferences = readPreferences(file, logger);
  if (!preferences) return false;
  const session = ensureSection(preferences, 'session');
  // Keep Preferences aligned with the command-line session restore decision.
  session.restore_on_startup = profile.restoreLastSession === true ? 1 : 5;
  session.startup_urls = [];
  const state = ensureSection(preferences, 'profile');
  state.exit_type = 'Normal';
  state.exited_cleanly = true;
  applyLocationPermission(state, profile.geolocationPermission);
  if (typeof profile.doNotTrack === 'boolean') preferences.enable_do_not_track = profile.doNotTrack;
  const languages = acceptedLanguages(profile);
  if (languages) {
    const intl = ensureSection(preferences, 'intl');
    intl.accept_languages = languages;
    intl.selected_languages = languages;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(preferences), 'utf8');
    return true;
  } catch (error) {
    callOptional(logger, 'warn', '[ChromiumRuntime] 写入启动偏好失败:', error.message);
    return false;
  }
}

module.exports = { applyChromiumSessionStartupPolicy };

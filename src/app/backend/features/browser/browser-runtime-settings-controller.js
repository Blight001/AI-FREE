'use strict';

const {
  normalizeAiFreeBrowserSettings,
  parseCookieJson,
} = require('../../utils/ai-free-browser-settings');
const {
  resolveChromiumExtensionPaths,
  resolveConfiguredBrowserProxy,
} = require('./browser-environment');
const { resolveBrowserEnvironmentProfile } = require('./browser-environment-profile');
const { buildBrowserRuntimeEnvironment } = require('./browser-tab-runtime-profile');
const { getClashMiniStatus } = require('../network/clash-mini-control-runtime');
const { resolveLowSpecMode } = require('./low-spec-mode-policy');
const { getChromiumHandshakeBudget } = require('../../browser-runtime/chromium-launch-recovery');
const { callOptional, firstText } = require('../../../shared/safe-values');

function resolveEffectiveBrowserProxy(deps, normalized) {
  const clashStatus = typeof getClashMiniStatus === 'function' ? getClashMiniStatus() : null;
  const globalMagicEnabled = Boolean(clashStatus && clashStatus.running === true && clashStatus.enabled === true);
  const configuredProxy = resolveConfiguredBrowserProxy(normalized);
  const magicProxy = callOptional(deps, 'getBrowserProxyEndpoint');
  const effectiveProxy = globalMagicEnabled ? magicProxy : configuredProxy;
  return { effectiveProxy: effectiveProxy || { enabled: false }, globalMagicEnabled };
}

function buildConfigurationUpdate(browserProfile, normalized, effectiveProxy) {
  return ({ lowSpecSystem }) => {
    const lowSpecMode = resolveLowSpecMode({ settings: normalized.lowSpecMode, system: lowSpecSystem }).enabled;
    return {
      ...buildBrowserRuntimeEnvironment(normalized, browserProfile, effectiveProxy),
      lowSpecMode,
      launchMode: lowSpecMode ? 'low-spec' : 'normal',
      launchTimeoutMs: getChromiumHandshakeBudget({ lowSpecMode }),
    };
  };
}

function saveResolvedTabSettings(tab, tabs, normalized, browserProfile) {
  const current = tab.browserSettings && typeof tab.browserSettings === 'object'
    ? tab.browserSettings
    : {};
  tab.browserSettings = { ...current, ...normalized };
  tab.browserProfile = browserProfile;
  tabs.set(tab.id, tab);
}

async function applyConfiguredCookies(deps, tabId, normalized) {
  const configuredCookies = parseCookieJson(normalized);
  if (!configuredCookies.length) return {};
  try {
    const result = await deps.browserRuntimeManager?.setCookies?.(tabId, configuredCookies);
    if (result?.imported === configuredCookies.length) return {};
  } catch (_) {
    callOptional(deps.logger || console, 'warn', '[ChromiumRuntime] AI-FREE Cookie 更新失败');
  }
  return { cookieWarning: '部分或全部 Cookie 未能写入 Chromium。' };
}

async function setTabBrowserSettings(deps, tabId, settings, options = {}) {
    const { browserRuntimeManager, resolveTabBrowserProfile, resolveTabs, updateTabs } = deps;
    const logger = deps.logger || console;
    try {
      const tabs = resolveTabs();
      const tab = tabs.get(firstText(tabId));
      if (!tab) return { ok: false, message: '当前没有可配置的浏览器标签页' };
      const normalized = normalizeAiFreeBrowserSettings(settings);
      const proxyState = resolveEffectiveBrowserProxy(deps, normalized);
      const browserProfile = await resolveBrowserEnvironmentProfile({
        settings: normalized,
        effectiveProxy: proxyState.effectiveProxy,
        resolveTabBrowserProfile,
        lookupByIp: deps.lookupByIp,
        logger,
      });
      saveResolvedTabSettings(tab, tabs, normalized, browserProfile);
      const cookieResult = await applyConfiguredCookies(deps, tab.id, normalized);
      const locationResult = browserProfile.geolocationWarning
        ? { geolocationWarning: browserProfile.geolocationWarning } : {};
      const configuration = browserRuntimeManager
        ? await browserRuntimeManager.updateProfileConfiguration(tab.id,
          buildConfigurationUpdate(browserProfile, normalized, proxyState.effectiveProxy),
          { restart: options.restartChromium === true })
        : null;
      if (options.restartChromium === true && browserRuntimeManager) {
        if (!configuration.data.found) throw new Error(`Chromium Profile ${tab.id} 不存在`);
        const state = configuration.data.state;
        tab.runtimeStatus = firstText(state && state.status, tab.runtimeStatus);
        tab.networkMagicApplied = proxyState.globalMagicEnabled && proxyState.effectiveProxy.enabled === true;
        updateTabs(true);
        return { ok: true, applied: !cookieResult.cookieWarning && !browserProfile.geolocationWarning,
          restarted: true, runtimeType: 'chromium', ...cookieResult, ...locationResult };
      }
      updateTabs(true);
      return { ok: true, applied: false, restartRequired: true, runtimeType: 'chromium', ...cookieResult, ...locationResult };
    } catch (error) {
      callOptional(logger, 'warn', '[BrowserSettings] 应用标签参数失败:', firstText(error && error.message, error));
      return { ok: false, message: firstText(error && error.message, error) };
    }
}
  
async function refreshBrowsersAfterExtensionChange(deps, change = {}) {
    const { browserRuntimeManager, extensionManager, resolveTabs, sendToSide, updateTabs } = deps;
    const logger = deps.logger || console;
    const entries = Array.from(resolveTabs().values());
    let chromiumRestarted = 0;
    const failures = [];
  
    for (const tab of entries) {
      try {
        const result = await browserRuntimeManager.updateProfileConfiguration(tab.id, {
          extensionPaths: resolveChromiumExtensionPaths(tab.browserSettings || {}, extensionManager),
        }, { restart: true });
        if (!result.data.found) continue;
        const runtimeState = result.data.state;
        tab.runtimeStatus = firstText(runtimeState && runtimeState.status, tab.runtimeStatus);
        chromiumRestarted += 1;
      } catch (error) {
        failures.push({ tabId: firstText(tab.id), runtimeType: 'chromium', message: firstText(error && error.message, error) });
        callOptional(logger, 'warn', `[Extensions] Chromium 环境 ${tab.id} 刷新失败:`, firstText(error && error.message, error));
      }
    }
  
    const result = {
      ok: failures.length === 0,
      pluginId: firstText(change && change.plugin && change.plugin.id),
      enabled: Boolean(change && change.enabled === true),
      chromiumRestarted,
      total: chromiumRestarted,
      failures,
    };
    updateTabs(true);
    try { sendToSide('extension-browsers-refreshed', result); } catch (_) {}
    return result;
}

function createBrowserRuntimeSettingsController(deps = {}) {
  return {
    refreshBrowsersAfterExtensionChange: (change) => refreshBrowsersAfterExtensionChange(deps, change),
    setTabBrowserSettings: (tabId, settings, options) => setTabBrowserSettings(deps, tabId, settings, options),
  };
}

module.exports = { createBrowserRuntimeSettingsController };

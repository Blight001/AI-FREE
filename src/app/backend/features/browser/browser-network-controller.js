'use strict';

const {
  getClashMiniStatus,
  getClashMiniProxyEndpoint,
  getClashMiniRuntimeRoot,
} = require('../network/clash-mini-control-runtime');
const { appContext } = require('../../runtime/app-context');
const {
  resolveConfiguredBrowserProxy,
  resolveProxyAuthentication,
} = require('./browser-environment');
const { callOptional, firstText } = require('../../../shared/safe-values');

function getBrowserProxyEndpoint() {
  const clashMiniStatus = typeof getClashMiniStatus === 'function' ? getClashMiniStatus() : null;
  const coreDir = firstText(
    clashMiniStatus && clashMiniStatus.coreDir,
    typeof getClashMiniRuntimeRoot === 'function' ? getClashMiniRuntimeRoot() : '',
  );
  if (!coreDir) return null;
  const endpoint = typeof getClashMiniProxyEndpoint === 'function' ? getClashMiniProxyEndpoint(coreDir) : null;
  if (!endpoint || !Number.isFinite(Number(endpoint.port))) return null;
  const host = firstText(endpoint.host, '127.0.0.1').trim();
  const protocol = firstText(endpoint.protocol, 'http').trim().toLowerCase();
  return {
    enabled: true,
    server: `${protocol}://${host || '127.0.0.1'}:${Number(endpoint.port)}`,
    bypassRules: '<local>;127.0.0.1;localhost;::1',
  };
}

function resolveTabProxy(tab, enabled, browserProxy) {
  if (enabled) return browserProxy || { enabled: false };
  return resolveConfiguredBrowserProxy(tab.browserSettings || {}) || { enabled: false };
}

async function applyProxyToTab(deps, tab, context) {
  const { enabled, browserProxy, failures } = context;
  try {
    const tabProxy = resolveTabProxy(tab, enabled, browserProxy);
    if (appContext.isShuttingDown()) return false;
    const nextProxyServer = firstText(tabProxy.server);
    const result = await deps.browserRuntimeManager.updateProfileConfiguration(tab.id, {
      proxyServer: nextProxyServer,
      proxyBypassList: tabProxy.enabled ? firstText(tabProxy.bypassRules) : '',
      proxyAuthentication: resolveProxyAuthentication(tabProxy),
    }, { restart: true, onlyIfChanged: true });
    if (!result.data.found) {
      tab.networkMagicApplied = false;
      return false;
    }
    const runtimeState = result.data.state;
    tab.runtimeStatus = firstText(runtimeState && runtimeState.status, tab.runtimeStatus);
    tab.networkMagicApplied = enabled && Boolean(nextProxyServer);
    return result.data.restarted;
  } catch (error) {
    tab.networkMagicApplied = false;
    const failure = { tabId: firstText(tab.id), message: firstText(error && error.message, error) };
    failures.push(failure);
    callOptional(deps.logger || console, 'warn', `[ChromiumRuntime] 网络魔法代理切换后重启失败 ${failure.tabId}:`, failure.message);
    return false;
  }
}

async function applyClashMiniBrowserProxy(deps, enabled = true, _options = {}) {
  const entries = Array.from(deps.resolveTabs().values());
  const failures = [];
  if (appContext.isShuttingDown()) {
    return { ok: true, enabled: false, updated: 0, total: entries.length, failures, skipped: true };
  }
  const context = {
    enabled: enabled === true,
    browserProxy: getBrowserProxyEndpoint(),
    failures,
  };
  const results = await Promise.all(entries.map((tab) => applyProxyToTab(deps, tab, context)));
  deps.updateTabs(true);
  return {
    ok: failures.length === 0,
    enabled: Boolean(enabled),
    updated: results.filter(Boolean).length,
    total: entries.length,
    failures,
  };
}

function createBrowserNetworkController(deps = {}) {
  return {
    applyClashMiniBrowserProxy: (enabled, options) => applyClashMiniBrowserProxy(deps, enabled, options),
    getBrowserProxyEndpoint,
  };
}

module.exports = { createBrowserNetworkController };

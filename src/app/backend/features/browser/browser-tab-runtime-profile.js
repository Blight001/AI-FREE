'use strict';

const { getChromiumHandshakeBudget } = require('../../browser-runtime/chromium-launch-recovery');
const {
  buildAppliedBrowserEnvironment,
  buildAppliedBrowserSettings,
  resolveChromiumExtensionPaths,
  resolveChromiumExtraArgs,
  resolveProxyAuthentication,
} = require('./browser-environment');
const { buildBrowserEnvironmentSettings } = require('./browser-environment-profile');

function buildBrowserRuntimeEnvironment(settings, profile, effectiveProxy = {}) {
  return {
    locale: profile?.locale,
    acceptLanguage: profile?.acceptLanguage,
    timezoneId: profile?.timezoneId,
    userAgent: profile?.userAgent,
    doNotTrack: settings.doNotTrack === true,
    geolocationPermission: settings.geolocation?.permission,
    geolocationResolution: profile?.geolocationResolution || null,
    geolocationWarning: profile?.geolocationWarning || '',
    environmentSettings: buildBrowserEnvironmentSettings(settings, profile),
    browserEnvironment: buildAppliedBrowserEnvironment(profile),
    browserSettingsSnapshot: buildAppliedBrowserSettings(settings),
    proxyServer: effectiveProxy?.server || '',
    proxyBypassList: effectiveProxy?.bypassRules || '',
    proxyAuthentication: resolveProxyAuthentication(effectiveProxy),
    extraArgs: resolveChromiumExtraArgs(settings),
  };
}

function buildBrowserTabRuntimeProfile(context, profile, extensionManager) {
  const { id, identity, urls, restoreLastSession, browserSettings, proxy, url } = context;
  const lowSpecMode = context.lowSpec?.enabled === true;
  return {
    profileId: id,
    runtimeType: 'chromium',
    launchMode: lowSpecMode ? 'low-spec' : 'normal',
    lowSpecMode,
    launchTimeoutMs: getChromiumHandshakeBudget({ lowSpecMode, coldStart: context.coldStart }),
    lowSpecSystem: context.resourceDecision?.snapshot,
    displayName: identity.fixedTitle,
    initialUrl: urls.initial,
    restoreLastSession,
    hideToolbar: context.options.hideBrowserToolbar === true,
    restoreFallbackUrl: String(url || '').trim(),
    ...buildBrowserRuntimeEnvironment(browserSettings, profile, proxy.value),
    executablePath: browserSettings.chromiumExecutablePath,
    extensionPaths: resolveChromiumExtensionPaths(browserSettings, extensionManager),
    allowPrototypeWindowDiscovery: browserSettings.allowPrototypeWindowDiscovery === true,
    remoteDebuggingPipe: browserSettings.remoteDebuggingPipe === true,
    autoGrantPermissionOrigins: browserSettings.automation?.permissionOrigins || [],
  };
}

module.exports = { buildBrowserRuntimeEnvironment, buildBrowserTabRuntimeProfile };

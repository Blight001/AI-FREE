'use strict';

const { startProxyAuthBridge } = require('../features/browser/proxy-auth-bridge');
const {
  cleanupStaleBrowserEnvironmentExtensions,
  removeBrowserEnvironmentExtension,
  writeBrowserEnvironmentExtension,
} = require('./chromium-browser-environment-extension');

async function prepareChromiumProfileEnvironment(context) {
  cleanupStaleBrowserEnvironmentExtensions(context.paths.root);
  context.environmentExtensionDir = writeBrowserEnvironmentExtension(
    context.paths.root,
    context.profile.environmentSettings || {},
  );
  const proxyAuth = context.profile.proxyAuthentication;
  if (proxyAuth && (proxyAuth.username || proxyAuth.password)) {
    context.proxyAuthBridge = await startProxyAuthBridge(proxyAuth);
  }
  return {
    ...context.profile,
    extensionPaths: [
      ...(Array.isArray(context.profile.extensionPaths) ? context.profile.extensionPaths : []),
      context.environmentExtensionDir,
    ],
    ...(context.proxyAuthBridge ? { proxyServer: context.proxyAuthBridge.proxyServer } : {}),
  };
}

async function cleanupChromiumProfileEnvironment(instance) {
  if (!instance) return;
  if (!instance.launchResourcesCleanup) {
    instance.launchResourcesCleanup = (async () => {
      try { await instance.proxyAuthBridge?.close?.(); } catch (_) {}
      removeBrowserEnvironmentExtension(instance.paths?.root, instance.environmentExtensionDir);
    })();
  }
  await instance.launchResourcesCleanup;
}

async function refreshChromiumEnvironmentProfile(runtime, profileId, update) {
  return runtime.enqueueProfileOperation(profileId, async () => {
    const instance = runtime.getReadyInstance(profileId);
    Object.assign(instance.profile, update);
    return runtime.restartNow(profileId);
  });
}

module.exports = {
  cleanupChromiumProfileEnvironment,
  prepareChromiumProfileEnvironment,
  refreshChromiumEnvironmentProfile,
};

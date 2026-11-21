'use strict';

const { startProxyAuthBridge } = require('../features/browser/proxy-auth-bridge');
const {
  cleanupStaleBrowserEnvironmentExtensions,
  writeBrowserEnvironmentExtension,
} = require('./chromium-browser-environment-extension');

const { cleanupStaleUploadStaging } = require('./chromium-upload-staging');

async function prepareChromiumProfileEnvironment(context) {
  cleanupStaleUploadStaging(context.paths.root);
  cleanupStaleBrowserEnvironmentExtensions(context.paths.root);
  context.resources.environmentExtensionDir = writeBrowserEnvironmentExtension(
    context.paths.root,
    context.profile.environmentSettings || {},
  );
  const proxyAuth = context.profile.proxyAuthentication;
  if (proxyAuth && (proxyAuth.username || proxyAuth.password)) {
    context.resources.proxyAuthBridge = await startProxyAuthBridge(proxyAuth);
  }
  return {
    ...context.profile,
    extensionPaths: [
      ...(Array.isArray(context.profile.extensionPaths) ? context.profile.extensionPaths : []),
      context.resources.environmentExtensionDir,
    ],
    ...(context.resources.proxyAuthBridge ? { proxyServer: context.resources.proxyAuthBridge.proxyServer } : {}),
  };
}

async function refreshChromiumEnvironmentProfile(runtime, profileId, update) {
  const result = await runtime.updateProfileConfiguration(profileId, update, { restart: true });
  if (!result.data.found) runtime.getReadyInstance(profileId);
  return result.data.state;
}

module.exports = {
  prepareChromiumProfileEnvironment,
  refreshChromiumEnvironmentProfile,
};

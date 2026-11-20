'use strict';

function profileText(value) { return String(value ?? '').trim(); }

function snapshotAppliedChromiumProfile(profile = {}, launchArgs = []) {
  const actualArgs = Array.isArray(launchArgs) ? launchArgs.map(profileText) : [];
  const extensionArg = actualArgs.find((item) => item.startsWith('--load-extension=')) ?? '';
  const loadedExtensions = extensionArg
    ? extensionArg.slice('--load-extension='.length).split(',').map((item) => item.trim()).filter(Boolean)
    : [];
  const proxyServer = profileText(profile.proxyServer);
  return {
    locale: profileText(profile.locale),
    acceptLanguage: profileText(profile.acceptLanguage),
    timezoneId: profileText(profile.timezoneId),
    userAgent: profileText(profile.userAgent),
    proxyServer: proxyServer.replace(/^(https?|socks4|socks5):\/\/[^/@\s]+:[^/@\s]+@/i, '$1://[redacted]@'),
    proxyBypassList: profileText(profile.proxyBypassList),
    hardwareAcceleration: !actualArgs.includes('--disable-gpu'),
    extensionCount: loadedExtensions.length,
    browserSettings: safeSettingsSnapshot(profile.browserSettingsSnapshot),
    browserEnvironment: profile.browserEnvironment && typeof profile.browserEnvironment === 'object'
      ? { ...profile.browserEnvironment }
      : null,
  };
}

function safeSettingsSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  const snapshot = JSON.parse(JSON.stringify(value));
  if (snapshot.proxy && typeof snapshot.proxy === 'object') {
    delete snapshot.proxy.username;
    delete snapshot.proxy.password;
    delete snapshot.proxy.apiUrl;
  }
  return snapshot;
}

module.exports = { snapshotAppliedChromiumProfile };

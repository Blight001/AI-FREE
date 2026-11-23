'use strict';

const { normalizeUserAgentBrands } = require('../../../shared/browser-identity');

const { resolveBrowserGeolocation } = require('./browser-ip-geolocation');

function hasResolvedLocation(permission, location) {
  return permission === 'allow' && Boolean(location);
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function buildUaSettings(settings) {
  const ua = objectValue(settings.ua);
  return { mode: ua.mode || 'default', value: ua.mode === 'custom' ? String(ua.value || '').slice(0, 512) : '' };
}

function buildSecChUaSettings(settings, profile) {
  const source = objectValue(settings.secChUa);
  const brands = source.mode === 'custom' ? source.brands : profile.uaBrands || source.brands;
  return {
    mode: source.mode || 'default',
    brands: normalizeUserAgentBrands(brands),
    majorVersion: profile.majorVersion || '',
    platform: profile.os || settings.os || '',
    platformVersion: profile.platformVersion || '',
    architecture: profile.architecture || '',
    bitness: profile.bitness || '',
    model: profile.model || '',
    mobile: profile.mobile === true,
  };
}

function buildWebGlSettings(settings) {
  const webgl = objectValue(settings.webglMetadata);
  return {
    mode: webgl.mode || 'default',
    vendor: String(webgl.vendor || '').slice(0, 128),
    renderer: String(webgl.renderer || '').slice(0, 256),
  };
}

function buildCanvasSettings(settings) {
  const canvas = objectValue(settings.canvas);
  return { mode: canvas.mode || 'default', seed: String(canvas.seed || '').slice(0, 128) };
}

function buildModeSetting(settings, key) {
  return { mode: objectValue(settings[key]).mode || 'default' };
}

function buildResolutionSettings(settings) {
  const value = objectValue(settings.resolution);
  return {
    mode: value.mode || 'follow',
    width: Number(value.width) || 0,
    height: Number(value.height) || 0,
  };
}

function buildDeviceNameSettings(settings) {
  const value = objectValue(settings.deviceName);
  return { mode: value.mode || 'default', value: String(value.value || '').slice(0, 64) };
}

function buildPortProtectionSettings(settings) {
  const value = objectValue(settings.portScanProtection);
  return {
    enabled: value.enabled === true,
    allowList: Array.isArray(value.allowList) ? value.allowList.slice(0, 64) : [],
  };
}

function buildGeolocationSettings(settings, profile) {
  const source = objectValue(settings.geolocation);
  const location = hasResolvedLocation(source.permission, profile.geolocationResolution)
    ? profile.geolocationResolution
    : null;
  if (!location) return { permission: source.permission || 'ask', enabled: false };
  return {
    permission: 'allow',
    enabled: true,
    latitude: location.latitude,
    longitude: location.longitude,
    accuracy: location.accuracy,
  };
}

function buildBrowserEnvironmentSettings(settings = {}, profile = {}) {
  return {
    nativeIdentity: profile.nativeIdentity === true,
    os: settings.os || '',
    browserVersion: settings.browserVersion || '',
    acceptLanguage: profile.acceptLanguage || '',
    doNotTrack: settings.doNotTrack === true,
    ua: buildUaSettings(settings),
    webrtc: { mode: objectValue(settings.webrtc).mode || 'allow' },
    canvas: buildCanvasSettings(settings),
    webglImage: buildModeSetting(settings, 'webglImage'),
    webgpu: buildModeSetting(settings, 'webgpu'),
    audioContext: buildModeSetting(settings, 'audioContext'),
    clientRects: buildModeSetting(settings, 'clientRects'),
    speechVoices: buildModeSetting(settings, 'speechVoices'),
    resolution: buildResolutionSettings(settings),
    deviceName: buildDeviceNameSettings(settings),
    portScanProtection: buildPortProtectionSettings(settings),
    cpu: settings.cpu,
    memory: settings.memory,
    userAgent: profile.userAgent || '',
    navigatorPlatform: profile.navigatorPlatform || '',
    navigatorVendor: profile.navigatorVendor || '',
    secChUa: buildSecChUaSettings(settings, profile),
    architecture: profile.architecture || '',
    bitness: profile.bitness || '',
    model: profile.model || '',
    platformVersion: profile.platformVersion || '',
    uaFullVersion: profile.uaFullVersion || '',
    uaFullVersionList: normalizeUserAgentBrands(profile.uaFullVersionList),
    wow64: profile.wow64 === true,
    webglMetadata: buildWebGlSettings(settings),
    geolocation: buildGeolocationSettings(settings, profile),
  };
}

async function resolveBrowserEnvironmentProfile(options = {}) {
  const settings = options.settings && typeof options.settings === 'object' ? options.settings : {};
  const resolveTabBrowserProfile = options.resolveTabBrowserProfile;
  const profile = typeof resolveTabBrowserProfile === 'function'
    ? await resolveTabBrowserProfile({ browserSettings: settings, logger: options.logger })
    : {};
  const geolocation = settings.geolocation && typeof settings.geolocation === 'object'
    ? settings.geolocation
    : {};
  if (geolocation.permission !== 'allow') {
    return { ...profile, geolocationResolution: null, geolocationWarning: '' };
  }

  try {
    const geolocationResolution = await resolveBrowserGeolocation(geolocation, {
      effectiveProxy: options.effectiveProxy,
      lookupByIp: options.lookupByIp,
    });
    return { ...profile, geolocationResolution, geolocationWarning: '' };
  } catch (error) {
    const code = error?.code === 'BROWSER_GEOLOCATION_PROVIDER_UNAVAILABLE'
      ? 'BROWSER_GEOLOCATION_PROVIDER_NOT_CONFIGURED'
      : String(error?.code || 'BROWSER_GEOLOCATION_LOOKUP_FAILED');
    options.logger?.warn?.('[BrowserSettings] 地理位置解析失败，当前浏览器未应用坐标:', code);
    return { ...profile, geolocationResolution: null, geolocationWarning: code };
  }
}

module.exports = { buildBrowserEnvironmentSettings, resolveBrowserEnvironmentProfile };

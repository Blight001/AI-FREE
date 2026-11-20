'use strict';

const { buildBrowserGraphicsEnvironmentSource } = require('./browser-environment-graphics');
const { buildBrowserMediaEnvironmentSource } = require('./browser-environment-media');
const { buildBrowserNavigatorEnvironmentSource } = require('./browser-environment-navigator');

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function limitedText(value, maximum = 128) {
  return String(value ?? '').trim().slice(0, maximum);
}

function boundedNumber(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) return null;
  return number;
}

function normalizeBrands(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((item) => ({
    brand: limitedText(item?.brand, 64),
    version: limitedText(item?.version, 32),
  })).filter((item) => item.brand && item.version);
}

function platformValues(value) {
  const platform = limitedText(value, 32).toLowerCase();
  if (platform.includes('mac')) return { navigator: 'MacIntel', uaData: 'macOS' };
  if (platform.includes('linux')) return { navigator: 'Linux x86_64', uaData: 'Linux' };
  return { navigator: 'Win32', uaData: 'Windows' };
}

function normalizeGeolocation(value) {
  const source = record(value);
  const latitude = boundedNumber(source.latitude, -90, 90);
  const longitude = boundedNumber(source.longitude, -180, 180);
  if (latitude === null || longitude === null || source.permission === 'block' || source.enabled === false) return null;
  return { latitude, longitude, accuracy: boundedNumber(source.accuracy, 1, 100000) || 100 };
}

function normalizeHighEntropy(settings, brands) {
  const deviceName = record(settings.deviceName);
  const result = {
    architecture: limitedText(settings.architecture, 32),
    bitness: limitedText(settings.bitness, 8),
    model: limitedText(deviceName.mode === 'custom' ? deviceName.value : settings.model, 64),
    platformVersion: limitedText(settings.platformVersion, 32),
    uaFullVersion: limitedText(settings.uaFullVersion, 32),
    fullVersionList: normalizeBrands(settings.uaFullVersionList),
    wow64: settings.wow64 === true,
  };
  const majorVersion = limitedText(settings.browserVersion, 16).split('.')[0];
  if (!result.uaFullVersion && majorVersion) result.uaFullVersion = `${majorVersion}.0.0.0`;
  if (!result.fullVersionList.length && brands.length) {
    result.fullVersionList = brands.map((item) => ({
      brand: item.brand,
      version: `${item.version.split('.')[0]}.0.0.0`,
    }));
  }
  return result;
}

function normalizeScreen(value) {
  const resolution = record(value);
  if (resolution.mode !== 'custom') return null;
  const width = boundedNumber(resolution.width, 800, 16384);
  const height = boundedNumber(resolution.height, 600, 16384);
  if (!width || !height) return null;
  return {
    width, height, availWidth: width, availHeight: height,
    availLeft: 0, availTop: 0, colorDepth: 24, pixelDepth: 24,
  };
}

function normalizeUserAgent(settings, ua, secChUa, platform, brands) {
  const customUserAgent = ua.mode === 'custom' ? limitedText(ua.value, 512) : '';
  const highEntropy = normalizeHighEntropy(settings, brands);
  return {
    highEntropy,
    mobile: secChUa.mode === 'custom'
      ? secChUa.mobile === true
      : /(?:\bmobile\b|android)/i.test(customUserAgent),
    navigatorPlatform: platform.navigator,
    navigatorVendor: limitedText(settings.navigatorVendor, 64),
    platformName: platform.uaData,
    secChUaBrands: brands,
    secChUaPlatformVersion: highEntropy.platformVersion,
    uaDataPlatform: platform.uaData,
    userAgent: customUserAgent,
  };
}

function normalizeVisualSettings(settings, canvas, webglImage) {
  const webgl = record(settings.webglMetadata);
  const seed = limitedText(settings.fingerprintSeed, 128) || limitedText(canvas.seed, 128) || 'ai-free';
  const deviceName = record(settings.deviceName);
  return {
    canvasMode: canvas.mode === 'noise' ? 'noise' : 'default',
    canvasSeed: limitedText(canvas.seed, 128) || seed,
    model: deviceName.mode === 'custom' ? limitedText(deviceName.value, 64) : '',
    screen: normalizeScreen(settings.resolution),
    webglImageMode: webglImage.mode === 'noise' ? 'noise' : 'default',
    webglImageSeed: limitedText(webglImage.seed, 128) || seed,
    webglMode: webgl.mode === 'custom' ? 'custom' : 'default',
    webglRenderer: limitedText(webgl.renderer, 256),
    webglVendor: limitedText(webgl.vendor, 128),
    webgpuMode: record(settings.webgpu).mode === 'webgl' ? 'webgl' : 'default',
  };
}

function normalizeSettings(value) {
  const settings = record(value);
  const secChUa = record(settings.secChUa);
  const ua = record(settings.ua);
  const platform = platformValues(settings.navigatorPlatform || settings.os);
  const brands = secChUa.mode === 'custom' ? normalizeBrands(secChUa.brands) : [];
  const canvas = record(settings.canvas);
  const visual = normalizeVisualSettings(settings, canvas, record(settings.webglImage));
  const identity = normalizeUserAgent(settings, ua, secChUa, platform, brands);
  const webrtc = record(settings.webrtc);
  return {
    audioContextMode: record(settings.audioContext).mode === 'noise' ? 'noise' : 'default',
    clientRectsMode: record(settings.clientRects).mode === 'noise' ? 'noise' : 'default',
    cpu: boundedNumber(settings.cpu, 1, 128),
    deviceMemory: boundedNumber(settings.memory, 0.25, 128),
    geolocation: normalizeGeolocation(settings.geolocation),
    mediaSeed: visual.canvasSeed,
    speechVoicesMode: record(settings.speechVoices).mode === 'noise' ? 'noise' : 'default',
    webrtcMode: ['allow', 'replace', 'block'].includes(webrtc.mode) ? webrtc.mode : 'allow',
    ...identity,
    ...visual,
  };
}

function buildBrowserEnvironmentScript(rawSettings = {}) {
  const config = JSON.stringify(normalizeSettings(rawSettings))
    .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `(() => { const config = ${config}; ${buildBrowserNavigatorEnvironmentSource()} ${buildBrowserGraphicsEnvironmentSource()} ${buildBrowserMediaEnvironmentSource()} })();`;
}

module.exports = { buildBrowserEnvironmentScript, normalizeBrowserEnvironmentScriptSettings: normalizeSettings };

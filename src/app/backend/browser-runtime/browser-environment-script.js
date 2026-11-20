'use strict';

const { loadBrowserEnvironmentTemplate } = require('./browser-environment-assets');
const { resolveBrowserIdentity } = require('./browser-environment-identity');

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

function normalizeGeolocation(value) {
  const source = record(value);
  const latitude = boundedNumber(source.latitude, -90, 90);
  const longitude = boundedNumber(source.longitude, -180, 180);
  if (latitude === null || longitude === null || source.permission === 'block' || source.enabled === false) return null;
  return { latitude, longitude, accuracy: boundedNumber(source.accuracy, 1, 100000) || 100 };
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
  const canvas = record(settings.canvas);
  const visual = normalizeVisualSettings(settings, canvas, record(settings.webglImage));
  const identity = resolveBrowserIdentity(settings);
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
  return loadBrowserEnvironmentTemplate().replace('__AI_FREE_ENVIRONMENT_CONFIG__', () => config);
}

module.exports = { buildBrowserEnvironmentScript, normalizeBrowserEnvironmentScriptSettings: normalizeSettings };

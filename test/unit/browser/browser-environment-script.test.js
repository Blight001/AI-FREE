'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const {
  buildBrowserEnvironmentScript,
  normalizeBrowserEnvironmentScriptSettings,
} = require('../../../src/app/backend/browser-runtime/browser-environment-script');

function runScript(settings, globals = {}) {
  const context = vm.createContext({ ...globals });
  vm.runInContext(buildBrowserEnvironmentScript(settings), context);
  return context;
}

test('configured platform agrees between page metadata and native launch metadata', async () => {
  const { buildChromiumUserAgentMetadataArgument } = require('../../../src/app/backend/browser-runtime/chromium-profile-args');
  for (const [os, platform] of [['mac', 'macOS'], ['linux', 'Linux'], ['win11', 'Windows']]) {
    const settings = { os, deviceName: { mode: 'custom', value: 'Configured Model' } };
    const context = runScript(settings, { navigator: { userAgentData: {
      brands: [{ brand: 'Chromium', version: '150' }], platform: 'Windows',
      getHighEntropyValues: async () => ({ architecture: 'x86' }),
    } } });
    const argument = buildChromiumUserAgentMetadataArgument(settings);
    const nativeMetadata = JSON.parse(Buffer.from(argument.split('=')[1], 'base64').toString('utf8'));
    assert.equal(context.navigator.userAgentData.platform, platform);
    assert.equal(nativeMetadata.platform, platform);
    const values = await context.navigator.userAgentData.getHighEntropyValues(['model', 'architecture']);
    assert.equal(values.model, 'Configured Model');
    assert.equal(values.architecture, 'x86');
    assert.equal(context.navigator.userAgentData.brands[0].version, '150');
  }
});

test('normalizes only web-visible settings and bounds untrusted values', () => {
  const normalized = normalizeBrowserEnvironmentScriptSettings({
    cpu: 1000,
    memory: 8,
    proxy: { username: 'private-user', password: 'private-secret' },
    secChUa: { mode: 'custom', brands: [{ brand: 'Chromium', version: '150' }] },
    geolocation: { permission: 'allow', mode: 'custom', latitude: 91, longitude: 20 },
  });

  assert.equal(normalized.cpu, null);
  assert.equal(normalized.geolocation, null);
  assert.equal('proxy' in normalized, false);
  const script = buildBrowserEnvironmentScript({
    ua: { mode: 'custom', value: '</script><script>secret()</script>' },
    proxy: { password: 'private-secret' },
  });
  assert.doesNotMatch(script, /private-secret|<\/script>/);
  assert.match(script, /\\u003c\/script>/);
});

test('overrides navigator values and returns custom user-agent metadata', async () => {
  const context = runScript({
    cpu: 12,
    memory: 16,
    os: 'win11',
    navigatorVendor: 'Google Inc.',
    browserVersion: '150.0.7871.114',
    ua: { mode: 'custom', value: 'Custom UA' },
    secChUa: {
      mode: 'custom',
      brands: [{ brand: 'Chromium', version: '150' }, { brand: 'Example', version: '7' }],
    },
  }, { navigator: {} });

  assert.equal(context.navigator.hardwareConcurrency, 12);
  assert.equal(context.navigator.deviceMemory, 16);
  assert.equal(context.navigator.platform, 'Win32');
  assert.equal(context.navigator.vendor, 'Google Inc.');
  assert.equal(context.navigator.userAgent, 'Custom UA');
  assert.deepEqual(JSON.parse(JSON.stringify(context.navigator.userAgentData.brands)), [
    { brand: 'Chromium', version: '150' },
    { brand: 'Example', version: '7' },
  ]);
  const highEntropy = await context.navigator.userAgentData.getHighEntropyValues(['uaFullVersion', 'platform']);
  assert.equal(highEntropy.uaFullVersion, '150.0.0.0');
  assert.equal(highEntropy.platform, 'Windows');
});

test('overrides configured WebGL metadata while preserving other parameters', () => {
  class WebGLRenderingContext {
    getParameter(parameter) { return `native-${parameter}`; }
  }
  const context = runScript({
    webglMetadata: { mode: 'custom', vendor: 'Configured Vendor', renderer: 'Configured Renderer' },
  }, { WebGLRenderingContext });
  const gl = new context.WebGLRenderingContext();

  assert.equal(gl.getParameter(0x9245), 'Configured Vendor');
  assert.equal(gl.getParameter(0x9246), 'Configured Renderer');
  assert.equal(gl.getParameter(0x1234), 'native-4660');
});

test('WebGL image noise changes pixel readbacks only when enabled', () => {
  const createContextClass = () => class WebGLRenderingContext {
    readPixels(_x, _y, _width, _height, _format, _type, pixels) { pixels.fill(100); }
  };
  const noisy = runScript({ webglImage: { mode: 'noise', seed: 'stable' } }, {
    WebGLRenderingContext: createContextClass(),
  });
  const noisyPixels = new Uint8Array(16);
  new noisy.WebGLRenderingContext().readPixels(0, 0, 2, 2, 0, 0, noisyPixels);
  assert.equal(Array.from(noisyPixels).filter((value) => value !== 100).length, 1);

  const native = runScript({ webglImage: { mode: 'default' } }, {
    WebGLRenderingContext: createContextClass(),
  });
  const nativePixels = new Uint8Array(16);
  new native.WebGLRenderingContext().readPixels(0, 0, 2, 2, 0, 0, nativePixels);
  assert.equal(Array.from(nativePixels).every((value) => value === 100), true);
});

test('uses configured geolocation only after permission is granted and keeps watch cleanup paired', async () => {
  const options = { maximumAge: 500 };
  const calls = { get: [], watch: [], cleared: [] };
  const nativePosition = {
    timestamp: 123,
    coords: { latitude: 1, longitude: 2, accuracy: 9, altitude: 10, altitudeAccuracy: 2, heading: 90, speed: 4 },
  };
  const geolocation = {
    getCurrentPosition(success, error, passedOptions) {
      calls.get.push(passedOptions);
      success(nativePosition);
    },
    watchPosition(success) { success(nativePosition); return 7; },
    clearWatch(id) { calls.cleared.push(id); },
  };
  const context = runScript({
    geolocation: { permission: 'allow', mode: 'custom', latitude: 31.23, longitude: 121.47, accuracy: 25 },
  }, {
    navigator: {
      geolocation,
      permissions: { query: async () => ({ state: 'granted' }) },
    },
  });
  let result;
  context.navigator.geolocation.getCurrentPosition((position) => { result = position; }, assert.fail, options);
  await new Promise(setImmediate);

  assert.equal(calls.get.length, 1);
  assert.equal(calls.get[0].maximumAge, 500);
  assert.equal(result.timestamp, 123);
  assert.equal(result.coords.latitude, 31.23);
  assert.equal(result.coords.longitude, 121.47);
  assert.equal(result.coords.accuracy, 25);
  let watched;
  const watchId = context.navigator.geolocation.watchPosition((position) => { watched = position; });
  await new Promise(setImmediate);
  assert.notEqual(watchId, 7);
  assert.equal(watched.coords.longitude, 121.47);
  context.navigator.geolocation.clearWatch(watchId);
  assert.deepEqual(calls.cleared, [7]);
});

test('keeps native geolocation denial behavior when permission is not granted', async () => {
  const denied = Object.assign(new Error('denied'), { code: 1 });
  const geolocation = {
    getCurrentPosition(_success, error) { error(denied); },
  };
  const context = runScript({ geolocation: { latitude: 31, longitude: 121 } }, {
    navigator: {
      geolocation,
      permissions: { query: async () => ({ state: 'denied' }) },
    },
  });
  let result;
  context.navigator.geolocation.getCurrentPosition(assert.fail, (error) => { result = error; });
  await new Promise(setImmediate);
  assert.equal(result, denied);
});

test('WebRTC replace mode requires relay candidates and block mode disables construction', () => {
  class NativePeerConnection {
    constructor(configuration) { this.configuration = configuration; }
  }
  const relayContext = runScript({ webrtc: { mode: 'replace' } }, { RTCPeerConnection: NativePeerConnection });
  const connection = new relayContext.RTCPeerConnection({ iceTransportPolicy: 'all', iceServers: [] });
  assert.equal(connection.configuration.iceTransportPolicy, 'relay');
  assert.deepEqual(JSON.parse(JSON.stringify(connection.configuration.iceServers)), []);

  const blocked = runScript({ webrtc: { mode: 'block' } }, { RTCPeerConnection: NativePeerConnection });
  assert.throws(() => new blocked.RTCPeerConnection(), (error) => error.name === 'NotSupportedError');
  const allowed = runScript({ webrtc: { mode: 'allow' } }, { RTCPeerConnection: NativePeerConnection });
  assert.equal(new allowed.RTCPeerConnection({ iceTransportPolicy: 'all' }).configuration.iceTransportPolicy, 'all');
});

test('canvas noise is deterministic and applies only to readbacks when enabled', () => {
  const createGlobals = () => ({
    ...(() => {
      class CanvasRenderingContext2D {
        constructor(canvas) { this.canvas = canvas; }
        getImageData(_x, _y, width, height) {
          return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(100) };
        }
        drawImage(source) { this.canvas.pixels = source.pixels.slice(); }
        putImageData(imageData, x, y) {
          const offset = (y * this.canvas.width + x) * 4;
          this.canvas.pixels.set(imageData.data, offset);
        }
      }
      class HTMLCanvasElement {
        constructor() {
          this.width = 4;
          this.height = 4;
          this.pixels = new Uint8ClampedArray(4 * 4 * 4).fill(100);
          this.context = new CanvasRenderingContext2D(this);
        }
        getContext() { return this.context; }
        toDataURL() { return Array.from(this.pixels).join(','); }
        toBlob(callback) { callback(Array.from(this.pixels).join(',')); }
      }
      return {
        CanvasRenderingContext2D,
        HTMLCanvasElement,
        document: { createElement: () => new HTMLCanvasElement() },
      };
    })(),
  });
  const noisy = runScript({ canvas: { mode: 'noise', seed: 'stable-seed' } }, createGlobals());
  const first = new noisy.CanvasRenderingContext2D({}).getImageData(0, 0, 4, 4).data;
  const second = new noisy.CanvasRenderingContext2D({}).getImageData(0, 0, 4, 4).data;
  assert.deepEqual(Array.from(first), Array.from(second));
  assert.equal(Array.from(first).filter((value) => value !== 100).length, 1);

  const source = new noisy.HTMLCanvasElement();
  const originalPixels = Array.from(source.pixels);
  const serialized = source.toDataURL();
  assert.notEqual(serialized, originalPixels.join(','));
  assert.deepEqual(Array.from(source.pixels), originalPixels);

  const defaultContext = runScript({ canvas: { mode: 'default' } }, createGlobals());
  const unchanged = new defaultContext.CanvasRenderingContext2D({}).getImageData(0, 0, 4, 4).data;
  assert.equal(Array.from(unchanged).every((value) => value === 100), true);
});

test('applies configured screen, model, WebGPU, and media fingerprint modes', async () => {
  class AnalyserNode {
    getFloatFrequencyData(data) { data.fill(0.5); }
  }
  class Element {
    constructor() { this.tagName = 'DIV'; this.id = 'sample'; this.className = ''; }
    getBoundingClientRect() { return { x: 10, y: 20, left: 10, top: 20, width: 30, height: 40, right: 40, bottom: 60 }; }
    getClientRects() { return [this.getBoundingClientRect()]; }
  }
  class SpeechSynthesis {
    getVoices() { return [{ name: 'A', lang: 'en' }, { name: 'B', lang: 'fr' }, { name: 'C', lang: 'zh' }]; }
  }
  const context = runScript({
    fingerprintSeed: 'stable',
    resolution: { mode: 'custom', width: 1440, height: 900 },
    deviceName: { mode: 'custom', value: 'DeviceModel' },
    webgpu: { mode: 'webgl' },
    audioContext: { mode: 'noise' },
    clientRects: { mode: 'noise' },
    speechVoices: { mode: 'noise' },
  }, {
    navigator: { userAgentData: { brands: [], platform: 'Windows', getHighEntropyValues: async () => ({}) }, gpu: { requestAdapter() {} } },
    screen: {}, AnalyserNode, Element, SpeechSynthesis,
  });

  assert.equal(context.screen.width, 1440);
  assert.equal(context.screen.height, 900);
  const modelData = await context.navigator.userAgentData.getHighEntropyValues(['model']);
  assert.equal(modelData.model, 'DeviceModel');
  assert.equal(context.navigator.gpu, undefined);
  const samples = new Float32Array(16);
  new context.AnalyserNode().getFloatFrequencyData(samples);
  assert.equal(Array.from(samples).some((value) => value !== 0.5), true);
  const rect = new context.Element().getBoundingClientRect();
  assert.notEqual(rect.left, 10);
  const rectList = new context.Element().getClientRects();
  assert.notEqual(rectList[0].top, 20);
  const voices = new context.SpeechSynthesis().getVoices();
  const voiceNames = JSON.parse(JSON.stringify(voices.map((voice) => voice.name)));
  assert.deepEqual(voiceNames.slice().sort(), ['A', 'B', 'C']);
  assert.notDeepEqual(voiceNames, ['A', 'B', 'C']);
});

test('preserves native high-entropy UA values that have no custom setting', async () => {
  const context = runScript({
    secChUa: { mode: 'custom', brands: [{ brand: 'Custom Chromium', version: '150' }] },
  }, {
    navigator: {
      userAgentData: {
        brands: [{ brand: 'Native Chromium', version: '147' }],
        platform: 'Windows',
        getHighEntropyValues: async () => ({ architecture: 'x86', model: 'Native Model' }),
      },
    },
  });
  const values = await context.navigator.userAgentData.getHighEntropyValues(['architecture', 'model']);
  assert.equal(values.architecture, 'x86');
  assert.equal(values.model, 'Native Model');
  assert.equal(values.brands[0].brand, 'Custom Chromium');
});

test('relay WebRTC mode keeps setConfiguration constrained to relay', () => {
  class NativePeerConnection {
    constructor(configuration) { this.configuration = configuration; }
    setConfiguration(configuration) { this.configuration = configuration; }
  }
  const context = runScript({ webrtc: { mode: 'replace' } }, { RTCPeerConnection: NativePeerConnection });
  const connection = new context.RTCPeerConnection({ iceTransportPolicy: 'all' });
  connection.setConfiguration({ iceTransportPolicy: 'all' });
  assert.equal(connection.configuration.iceTransportPolicy, 'relay');
});

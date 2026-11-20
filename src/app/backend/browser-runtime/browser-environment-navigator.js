'use strict';

function defineNavigatorValue(target, key, value) {
  if (target == null || value == null || value === '') return;
  try { Object.defineProperty(target, key, { configurable: true, get: () => value }); } catch (_) {}
}

function defineNavigatorMethod(target, name, method) {
  try { Object.defineProperty(target, name, { configurable: true, value: method }); } catch (_) {}
}

function hideNavigatorValue(target, key) {
  try { Object.defineProperty(target, key, { configurable: true, value: undefined }); } catch (_) {}
}

function installUserAgentData(navigatorObject, config) {
  const nativeData = navigatorObject.userAgentData;
  const customBrands = config.secChUaBrands.length > 0;
  if (!customBrands && !config.model && !config.userAgentDataPlatform) return;
  const brands = customBrands
    ? config.secChUaBrands.map((item) => Object.freeze({ ...item }))
    : Array.from(nativeData?.brands || [], (item) => Object.freeze({ brand: item.brand, version: item.version }));
  const fullVersionList = config.highEntropy.fullVersionList.length
    ? config.highEntropy.fullVersionList.map((item) => Object.freeze({ ...item }))
    : Array.from(nativeData?.brands || [], (item) => Object.freeze({ brand: item.brand, version: item.version }));
  const highEntropy = { ...config.highEntropy, fullVersionList };
  const platform = config.userAgentDataPlatform || nativeData?.platform || config.platformName;
  const data = Object.freeze({
    brands: Object.freeze(brands),
    mobile: Boolean(config.mobile),
    platform,
    getHighEntropyValues: async (hints) => getUserAgentHighEntropyValues(
      hints, highEntropy, brands, platform, config, nativeData,
    ),
    toJSON: () => ({ brands, mobile: Boolean(config.mobile), platform }),
  });
  defineNavigatorValue(navigatorObject, 'userAgentData', data);
}

async function getUserAgentHighEntropyValues(hints, highEntropy, brands, platform, config, nativeData) {
  const requested = Array.isArray(hints) ? hints : [];
  let nativeValues = {};
  if (typeof nativeData?.getHighEntropyValues === 'function') {
    try { nativeValues = await nativeData.getHighEntropyValues(requested); } catch (_) {}
  }
  const result = { ...nativeValues, brands, mobile: Boolean(config.mobile), platform };
  for (const hint of requested) {
    if (hasConfiguredHint(highEntropy, hint)) result[hint] = highEntropy[hint];
  }
  return result;
}

function hasConfiguredHint(highEntropy, hint) {
  if (!Object.prototype.hasOwnProperty.call(highEntropy, hint)) return false;
  const value = highEntropy[hint];
  return typeof value === 'boolean' || (Array.isArray(value) ? value.length > 0 : Boolean(value));
}

function installGeolocation(navigatorObject, configured) {
  const geolocation = navigatorObject.geolocation;
  if (!configured || !geolocation) return;
  const originalGet = geolocation.getCurrentPosition;
  const originalWatch = geolocation.watchPosition;
  const originalClear = geolocation.clearWatch;
  if (typeof originalGet !== 'function') return;
  const watches = new Map();
  let sequence = 0;

  defineNavigatorMethod(geolocation, 'getCurrentPosition', function (success, error, options) {
    withGeolocationPermission(navigatorObject, (state) => {
      const callback = state === 'granted' && typeof success === 'function'
        ? (position) => success(createConfiguredPosition(configured, position))
        : success;
      originalGet.call(geolocation, callback, error, options);
    }, () => originalGet.call(geolocation, success, error, options));
  });

  if (typeof originalWatch === 'function') {
    defineNavigatorMethod(geolocation, 'watchPosition', function (success, error, options) {
      const watchId = 1000000000 + (++sequence);
      const watch = { active: true, nativeId: null };
      watches.set(watchId, watch);
      withGeolocationPermission(navigatorObject, (state) => {
        if (!watch.active) return;
        const callback = state === 'granted' && typeof success === 'function'
          ? (position) => success(createConfiguredPosition(configured, position))
          : success;
        watch.nativeId = originalWatch.call(geolocation, callback, error, options);
      }, () => {
        if (watch.active) watch.nativeId = originalWatch.call(geolocation, success, error, options);
      });
      return watchId;
    });
  }

  if (typeof originalClear === 'function') {
    defineNavigatorMethod(geolocation, 'clearWatch', function (watchId) {
      const watch = watches.get(watchId);
      if (!watch) return originalClear.call(geolocation, watchId);
      watch.active = false;
      watches.delete(watchId);
      if (watch.nativeId !== null) originalClear.call(geolocation, watch.nativeId);
      return undefined;
    });
  }
}

function withGeolocationPermission(navigatorObject, onGranted, onNative) {
  const query = navigatorObject.permissions?.query;
  if (typeof query !== 'function') return onNative();
  let permission;
  try { permission = query.call(navigatorObject.permissions, { name: 'geolocation' }); } catch (_) { return onNative(); }
  Promise.resolve(permission).then((result) => {
    if (result?.state === 'granted') onGranted('granted');
    else onGranted(String(result?.state || 'prompt'));
  }, onNative);
}

function createConfiguredPosition(configured, nativePosition) {
  const coords = nativePosition && nativePosition.coords ? nativePosition.coords : {};
  return {
    timestamp: Number(nativePosition?.timestamp) || Date.now(),
    coords: {
      latitude: configured.latitude,
      longitude: configured.longitude,
      accuracy: configured.accuracy,
      altitude: coords.altitude ?? null,
      altitudeAccuracy: coords.altitudeAccuracy ?? null,
      heading: coords.heading ?? null,
      speed: coords.speed ?? null,
    },
  };
}

function installWebRtc(mode) {
  if (mode === 'allow') return;
  const wrappedPrototypes = new WeakSet();
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
    const Native = globalThis[name];
    if (typeof Native !== 'function') continue;
    if (mode === 'block') {
      replaceWebRtcConstructor(name, new Proxy(Native, {
        construct() { throw webRtcBlockedError(); },
      }));
      continue;
    }
    wrapRelayConfiguration(Native.prototype, wrappedPrototypes);
    replaceWebRtcConstructor(name, new Proxy(Native, {
      construct(target, args) {
        return Reflect.construct(target, [relayConfiguration(args[0]), ...args.slice(1)], target);
      },
    }));
  }
}

function wrapRelayConfiguration(prototype, wrappedPrototypes) {
  if (!prototype || wrappedPrototypes.has(prototype)) return;
  wrappedPrototypes.add(prototype);
  const original = prototype.setConfiguration;
  if (typeof original !== 'function') return;
  defineNavigatorMethod(prototype, 'setConfiguration', function (configuration) {
    return original.call(this, relayConfiguration(configuration));
  });
}

function relayConfiguration(configuration) {
  const source = configuration && typeof configuration === 'object' ? configuration : {};
  return { ...source, iceTransportPolicy: 'relay' };
}

function replaceWebRtcConstructor(name, Wrapped) {
  try { Object.defineProperty(globalThis, name, { configurable: true, value: Wrapped }); } catch (_) {}
}

function webRtcBlockedError() {
  if (typeof globalThis.DOMException === 'function') {
    return new globalThis.DOMException('WebRTC is disabled by browser settings', 'NotSupportedError');
  }
  const error = new Error('WebRTC is disabled by browser settings');
  error.name = 'NotSupportedError';
  return error;
}

function installBrowserNavigatorEnvironment(config) {
  const navigatorObject = globalThis.navigator;
  if (navigatorObject) {
    defineNavigatorValue(navigatorObject, 'hardwareConcurrency', config.cpu);
    defineNavigatorValue(navigatorObject, 'deviceMemory', config.deviceMemory);
    defineNavigatorValue(navigatorObject, 'platform', config.navigatorPlatform);
    defineNavigatorValue(navigatorObject, 'vendor', config.navigatorVendor);
    defineNavigatorValue(navigatorObject, 'userAgent', config.userAgent);
    installUserAgentData(navigatorObject, config);
    installGeolocation(navigatorObject, config.geolocation);
    if (config.webgpuMode === 'webgl') hideNavigatorValue(navigatorObject, 'gpu');
  }
  installWebRtc(config.webrtcMode);
}

function buildBrowserNavigatorEnvironmentSource() {
  const dependencies = [
    defineNavigatorValue, defineNavigatorMethod, hideNavigatorValue, installUserAgentData,
    getUserAgentHighEntropyValues, hasConfiguredHint,
    installGeolocation, withGeolocationPermission, createConfiguredPosition, installWebRtc,
    wrapRelayConfiguration, relayConfiguration, replaceWebRtcConstructor, webRtcBlockedError,
    installBrowserNavigatorEnvironment,
  ];
  const declarations = dependencies.map((fn) => `const ${fn.name} = ${fn.toString()};`).join('\n');
  return `(() => { ${declarations}\ninstallBrowserNavigatorEnvironment(config); })();`;
}

module.exports = { buildBrowserNavigatorEnvironmentSource };

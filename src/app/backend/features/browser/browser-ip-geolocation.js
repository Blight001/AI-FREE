'use strict';

function fail(code, message) {
  const error = /** @type {Error & {code: string}} */ (new Error(message));
  error.code = code;
  return error;
}

function finiteNumber(value, name, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw fail('BROWSER_GEOLOCATION_DATA_INVALID', `IP 定位结果中的 ${name} 无效`);
  }
  return number;
}

function firstValue(source, keys) {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function safeText(value, limit = 120) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function normalizeLocation(location, settings, source) {
  const data = location && typeof location === 'object' ? location : {};
  const accuracyValue = firstValue(data, ['accuracy', 'accuracy_m', 'accuracyMeters']);
  return {
    source,
    longitude: finiteNumber(firstValue(data, ['longitude', 'lon', 'lng']), '经度', -180, 180),
    latitude: finiteNumber(firstValue(data, ['latitude', 'lat']), '纬度', -90, 90),
    accuracy: finiteNumber(accuracyValue ?? settings.accuracy ?? 100, '精度', 1, 100000),
    sourceIp: safeText(firstValue(data, ['ip', 'sourceIp']), 64),
    sourceCountryCode: safeText(firstValue(data, ['country_code', 'countryCode']), 8).toUpperCase(),
    sourceCountry: safeText(firstValue(data, ['country_name', 'countryName', 'country']), 120),
    sourceRegion: safeText(firstValue(data, ['region', 'region_name', 'regionName']), 120),
    sourceCity: safeText(firstValue(data, ['city']), 120),
    timezoneId: safeText(firstValue(data, ['timezone', 'timezoneId']), 100),
  };
}

/**
 * Resolve coordinates for the browser without coupling the feature to a
 * particular IP-location vendor or network stack.
 *
 * lookupByIp receives `{ effectiveProxy }` and must query the browser's actual
 * egress route. Proxy credentials stay inside that injected transport.
 */
/**
 * @param {Record<string, any>} [geolocation]
 * @param {{lookupByIp?: (options: {effectiveProxy?: any}) => Promise<any>, effectiveProxy?: any}} [options]
 */
async function resolveBrowserGeolocation(geolocation = {}, options = {}) {
  const settings = geolocation && typeof geolocation === 'object' ? geolocation : {};
  const mode = String(settings.mode || 'ip').trim();
  if (mode === 'custom') return normalizeLocation(settings, settings, 'custom');
  if (mode !== 'ip') throw fail('BROWSER_GEOLOCATION_MODE_INVALID', '地理位置模式无效');
  if (typeof options.lookupByIp !== 'function') {
    throw fail('BROWSER_GEOLOCATION_PROVIDER_UNAVAILABLE', 'IP 定位服务不可用');
  }

  let location;
  try {
    location = await options.lookupByIp({ effectiveProxy: options.effectiveProxy || null });
  } catch (_) {
    throw fail('BROWSER_GEOLOCATION_LOOKUP_FAILED', '无法通过当前网络出口获取地理位置');
  }
  try {
    return normalizeLocation(location, settings, 'ip');
  } catch (error) {
    if (error && error.code === 'BROWSER_GEOLOCATION_DATA_INVALID') throw error;
    throw fail('BROWSER_GEOLOCATION_DATA_INVALID', 'IP 定位服务返回的数据无效');
  }
}

module.exports = { resolveBrowserGeolocation };

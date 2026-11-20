'use strict';

const LOCATION_ENDPOINT = 'https://ipwho.is/?fields=success,message,ip,country_code,country,region,city,latitude,longitude,timezone';
const LOCATION_PARTITION = 'ai-free-browser-ip-geolocation';

function proxyConfiguration(effectiveProxy) {
  const proxy = effectiveProxy && typeof effectiveProxy === 'object' ? effectiveProxy : null;
  const server = String(proxy?.server || '').trim();
  if (!server) return { mode: 'system' };
  if (server === 'direct://') return { mode: 'direct' };
  const parsed = new URL(server);
  if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(parsed.protocol)) {
    throw new Error('当前代理协议不支持 IP 定位查询');
  }
  return { proxyRules: server };
}

function readLocationResponse(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let byteCount = 0;
    response.on('data', (chunk) => {
      byteCount += chunk.length;
      if (byteCount > 65536) {
        reject(new Error('IP 定位响应过大'));
        response.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => {
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (response.statusCode < 200 || response.statusCode >= 300 || result.success !== true) {
          reject(new Error('IP 定位服务未返回有效位置'));
          return;
        }
        resolve({
          ip: result.ip,
          country_code: result.country_code,
          country: result.country,
          region: result.region,
          city: result.city,
          latitude: result.latitude,
          longitude: result.longitude,
          timezone: result.timezone?.id,
        });
      } catch (_) {
        reject(new Error('IP 定位响应格式无效'));
      }
    });
    response.on('error', () => reject(new Error('IP 定位响应读取失败')));
  });
}

function requestLocation(net, requestSession, credentials) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const request = net.request({ method: 'GET', url: LOCATION_ENDPOINT, session: requestSession });
    const timer = setTimeout(() => {
      request.abort();
      finish(new Error('IP 定位请求超时'));
    }, 10000);
    timer.unref?.();
    request.on('login', (_authInfo, callback) => {
      if (credentials.username || credentials.password) {
        callback(credentials.username, credentials.password);
      } else callback();
    });
    request.on('response', (response) => {
      readLocationResponse(response).then(
        (location) => finish(null, location),
        () => finish(new Error('IP 定位服务请求失败')),
      );
    });
    request.on('error', () => finish(new Error('IP 定位服务请求失败')));
    request.end();
  });
}

/** @param {{net?: any, session?: any}} [options] */
function createBrowserIpGeolocationLookup(options = {}) {
  let { net, session } = options;
  if (!net || !session) {
    const electron = require('electron');
    net = net || electron.net;
    session = session || electron.session;
  }
  let queue = Promise.resolve();
  let requestSession = null;
  /** @param {{effectiveProxy?: any}} [lookupOptions] */
  return (lookupOptions = {}) => {
    const { effectiveProxy } = lookupOptions;
    const lookup = queue.catch(() => {}).then(async () => {
      requestSession ||= session.fromPartition(LOCATION_PARTITION, { cache: false });
      await requestSession.closeAllConnections?.();
      await requestSession.setProxy(proxyConfiguration(effectiveProxy));
      return requestLocation(net, requestSession, {
        username: String(effectiveProxy?.username || ''),
        password: String(effectiveProxy?.password || ''),
      });
    });
    queue = lookup.catch(() => {});
    return lookup;
  };
}

module.exports = { createBrowserIpGeolocationLookup };

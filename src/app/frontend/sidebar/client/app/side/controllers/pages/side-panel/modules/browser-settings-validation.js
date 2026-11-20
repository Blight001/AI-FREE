'use strict';

function validateBrowserCookies(setting) {
  let cookies;
  try { cookies = JSON.parse(String(setting.cookies || '[]')); } catch (_) { throw new Error('Cookie 必须是有效的 JSON 数组'); }
  if (!Array.isArray(cookies)) throw new Error('Cookie 顶层必须是数组');
}

function validateBrowserHomepage(setting) {
  if (!setting.homepage || setting.homepage.mode !== 'custom') return;
  try {
    const parsed = new URL(setting.homepage.url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error();
  } catch (_) {
    throw new Error('启动主页必须是有效的 HTTP/HTTPS 地址');
  }
}

function validateBrowserClientHints(setting) {
  const hints = setting.secChUa || {};
  if (hints.mode !== 'custom') return;
  if (!Array.isArray(hints.brands) || hints.brands.length === 0
      || hints.brands.some((item) => !String(item?.brand || '').trim() || !String(item?.version || '').trim())) {
    throw new Error('Sec-CH-UA 每项都需要填写品牌和版本');
  }
}

function validateBrowserGeolocation(setting) {
  const location = setting.geolocation || {};
  if (location.mode !== 'custom') return;
  const longitude = Number(location.longitude);
  const latitude = Number(location.latitude);
  const accuracy = Number(location.accuracy);
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error('经度范围必须在 -180 到 180 之间');
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw new Error('纬度范围必须在 -90 到 90 之间');
  if (!Number.isFinite(accuracy) || accuracy < 1 || accuracy > 100000) throw new Error('定位精度范围必须在 1 到 100000 米之间');
}

window.validateAiFreeBrowserSettings = function validateAiFreeBrowserSettings(setting) {
  validateBrowserCookies(setting);
  const proxy = setting.proxy || {};
  const ua = setting.ua || {};
  const port = Number(proxy.port);
  if (proxy.mode === 'custom'
      && (!String(proxy.host || '').trim() || !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('自定义代理需要有效的主机和 1 到 65535 之间的整数端口');
  }
  if (ua.mode === 'custom' && !String(ua.value || '').trim()) throw new Error('自定义 User Agent 不能为空');
  validateBrowserClientHints(setting);
  validateBrowserGeolocation(setting);
  validateBrowserHomepage(setting);
  if (setting.timezone?.mode === 'custom') {
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: setting.timezone.value });
    } catch (_) {
      throw new Error('请输入有效时区，例如 Asia/Shanghai');
    }
  }
}

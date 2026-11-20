'use strict';

const { normalizeUserAgentBrands } = require('../../shared/browser-identity');

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function limitedText(value, maximum = 128) {
  return String(value ?? '').trim().slice(0, maximum);
}

function platformValues(value) {
  const platform = limitedText(value, 32).toLowerCase();
  if (platform.includes('mac')) return { navigator: 'MacIntel', uaData: 'macOS' };
  if (platform.includes('linux')) return { navigator: 'Linux x86_64', uaData: 'Linux' };
  return { navigator: 'Win32', uaData: 'Windows' };
}

function normalizeHighEntropy(settings, brands) {
  const deviceName = record(settings.deviceName);
  const result = {
    architecture: limitedText(settings.architecture, 32),
    bitness: limitedText(settings.bitness, 8),
    model: limitedText(deviceName.mode === 'custom' ? deviceName.value : settings.model, 64),
    platformVersion: limitedText(settings.platformVersion, 32),
    uaFullVersion: limitedText(settings.uaFullVersion, 32),
    fullVersionList: normalizeUserAgentBrands(settings.uaFullVersionList),
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

function resolveBrowserIdentity(settings) {
  const secChUa = record(settings.secChUa);
  const brands = secChUa.mode === 'custom' ? normalizeUserAgentBrands(secChUa.brands) : [];
  const platform = platformValues(settings.navigatorPlatform || settings.os);
  return normalizeUserAgent(settings, record(settings.ua), secChUa, platform, brands);
}

module.exports = { resolveBrowserIdentity };

'use strict';

const fs = require('fs');
const path = require('path');

const PRODUCTION_HEYSURE_SERVER = 'http://49.234.181.190:58150';
const LOCAL_TEST_HEYSURE_SERVER = 'http://127.0.0.1:3000';
const LEGACY_DEFAULT_HEYSURE_SERVER = 'http://49.234.181.190:3000';

function enabled(value) {
  return /^(1|true|yes)$/i.test(String(value || ''));
}

function loadDefaultHeySureServer(env = process.env) {
  const localTest = enabled(env?.HEYSURE_LOCAL_TEST);
  const key = localTest ? 'local_test_server_url' : 'default_server_url';
  const fallback = localTest ? LOCAL_TEST_HEYSURE_SERVER : PRODUCTION_HEYSURE_SERVER;
  try {
    const file = path.resolve(__dirname, '../../../../../../device.config.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    return String(config[key] || fallback).trim().replace(/\/+$/, '');
  } catch (_) {
    return fallback;
  }
}

const DEFAULT_HEYSURE_SERVER = loadDefaultHeySureServer();

function normalizeServerUrl(value, fallback = DEFAULT_HEYSURE_SERVER) {
  const raw = String(value || fallback).trim().replace(/\/+$/, '');
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('HeySure 地址仅支持 HTTP 或 HTTPS');
  return parsed.toString().replace(/\/$/, '');
}

function resolveHeySureServer(value, env = process.env) {
  const profileServer = loadDefaultHeySureServer(env);
  const explicitServer = String(env?.HEYSURE_SERVER || '').trim();
  const selected = enabled(env?.HEYSURE_FORCE_SERVER_MODE)
    ? profileServer
    : (explicitServer || value || profileServer);
  return normalizeServerUrl(selected, profileServer);
}

function requiredText(value, label, maxLength) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`请输入${label}`);
  if (text.length > maxLength) throw new Error(`${label}长度不能超过 ${maxLength} 个字符`);
  return text;
}

function normalizeLoginConfig(input = {}, env = process.env) {
  return {
    server: resolveHeySureServer(input.server, env),
    account: requiredText(input.account, '账号', 200),
    password: requiredText(input.password, '密码', 4096),
    serviceName: String(input.serviceName || 'AI-FREE').trim().slice(0, 80) || 'AI-FREE',
  };
}

function migrateSavedLoginConfig(saved, env = process.env) {
  if (String(saved?.server || '').replace(/\/+$/, '') !== LEGACY_DEFAULT_HEYSURE_SERVER) return saved;
  return { ...saved, server: loadDefaultHeySureServer(env) };
}

module.exports = {
  DEFAULT_HEYSURE_SERVER,
  loadDefaultHeySureServer,
  migrateSavedLoginConfig,
  normalizeLoginConfig,
  normalizeServerUrl,
  resolveHeySureServer,
};

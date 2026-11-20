'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildBrowserEnvironmentScript } = require('./browser-environment-script');

const OWNER_MARKER = 'ai-free-browser-environment-v1';
const GENERATED_FILES = ['manifest.json', 'rules.json', 'main.js', '.owner'];
const MAX_ALLOWED_PORTS = 64;

function localAddressPattern() {
  return '(?:localhost|127(?:\\.[0-9]{1,3}){3}|10(?:\\.[0-9]{1,3}){3}|192\\.168(?:\\.[0-9]{1,3}){2}|172\\.(?:1[6-9]|2[0-9]|3[01])(?:\\.[0-9]{1,3}){2}|169\\.254(?:\\.[0-9]{1,3}){2}|\\[::1\\])';
}

function normalizeAllowedPorts(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((port) => Number.isInteger(port) && port > 0 && port <= 65535))]
    .slice(0, MAX_ALLOWED_PORTS);
}

function buildPortProtectionRules(settings, nextId) {
  const protection = settings.portScanProtection || {};
  if (protection.enabled !== true) return [];
  const address = localAddressPattern();
  const root = `^https?://${address}`;
  const allowedPorts = [...new Set([80, 443, ...normalizeAllowedPorts(protection.allowList)])];
  const allowedPattern = `${root}(?::(?:${allowedPorts.join('|')}))?(?:/|$)`;
  const targetPattern = `${root}(?::[0-9]{1,5})?(?:/|$)`;
  return [
    { id: nextId(), priority: 2, action: { type: 'allow' }, condition: { regexFilter: allowedPattern } },
    { id: nextId(), priority: 1, action: { type: 'block' }, condition: { regexFilter: targetPattern } },
  ];
}

function buildBrowserEnvironmentExtensionFiles(settings = {}) {
  let nextId = 1;
  const rules = buildPortProtectionRules(settings, () => nextId++);
  return {
    manifest: {
      manifest_version: 3,
      name: 'AI-FREE Browser Environment',
      version: '1.0.0',
      permissions: rules.length ? ['declarativeNetRequest'] : [],
      host_permissions: ['<all_urls>'],
      content_scripts: [{
        matches: ['<all_urls>'],
        js: ['main.js'],
        run_at: 'document_start',
        all_frames: true,
        match_about_blank: true,
        world: 'MAIN',
      }],
      ...(rules.length ? { declarative_net_request: {
        rule_resources: [{ id: 'browser_environment', enabled: true, path: 'rules.json' }],
      } } : {}),
    },
    rules,
    script: buildBrowserEnvironmentScript(settings),
  };
}

function safeRuntimeDirectory(root, directory) {
  const resolvedRoot = path.resolve(root);
  const resolvedDirectory = path.resolve(directory);
  const relative = path.relative(resolvedRoot, resolvedDirectory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('浏览器环境扩展目录越界');
  }
  return resolvedDirectory;
}

function writeBrowserEnvironmentExtension(profileRoot, settings) {
  const id = crypto.randomBytes(12).toString('hex');
  const directory = safeRuntimeDirectory(profileRoot, path.join(profileRoot, `runtime-environment-${id}`));
  fs.mkdirSync(directory, { recursive: false });
  try {
    const files = buildBrowserEnvironmentExtensionFiles(settings);
    fs.writeFileSync(path.join(directory, '.owner'), OWNER_MARKER, { encoding: 'utf8', flag: 'wx' });
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(files.manifest), { encoding: 'utf8', flag: 'wx' });
    fs.writeFileSync(path.join(directory, 'rules.json'), JSON.stringify(files.rules), { encoding: 'utf8', flag: 'wx' });
    fs.writeFileSync(path.join(directory, 'main.js'), files.script, { encoding: 'utf8', flag: 'wx' });
    return directory;
  } catch (error) {
    removeBrowserEnvironmentExtension(profileRoot, directory);
    throw error;
  }
}

function removeBrowserEnvironmentExtension(profileRoot, directory) {
  if (!directory) return false;
  const target = safeRuntimeDirectory(profileRoot, directory);
  let marker = '';
  try { marker = fs.readFileSync(path.join(target, '.owner'), 'utf8'); } catch (_) { return false; }
  if (marker !== OWNER_MARKER) return false;
  for (const name of GENERATED_FILES) {
    const file = path.join(target, name);
    try {
      if (fs.lstatSync(file).isFile()) fs.unlinkSync(file);
    } catch (_) {}
  }
  try { fs.rmdirSync(target); return true; } catch (_) { return false; }
}

function cleanupStaleBrowserEnvironmentExtensions(profileRoot) {
  let entries = [];
  try { entries = fs.readdirSync(profileRoot, { withFileTypes: true }); } catch (_) { return 0; }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^runtime-environment-[a-f0-9]{24}$/.test(entry.name)) continue;
    if (removeBrowserEnvironmentExtension(profileRoot, path.join(profileRoot, entry.name))) removed += 1;
  }
  return removed;
}

module.exports = {
  buildBrowserEnvironmentExtensionFiles,
  cleanupStaleBrowserEnvironmentExtensions,
  removeBrowserEnvironmentExtension,
  writeBrowserEnvironmentExtension,
};

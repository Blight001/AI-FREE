'use strict';

const { execFile } = require('child_process');

const INTERNET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const REG_TIMEOUT_MS = 5000;
let ownedSnapshot = null;

function runRegistry(args, { allowMissing = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('reg.exe', args, { encoding: 'utf8', windowsHide: true, timeout: REG_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (!error) {
        resolve(String(stdout || ''));
        return;
      }
      if (allowMissing && Number(error.code) === 1) {
        resolve('');
        return;
      }
      reject(new Error(String(stderr || stdout || error.message).trim()));
    });
  });
}

function parseRegistryOutput(output, name) {
  const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*${escapedName}\\s+REG_[A-Z0-9_]+\\s+(.*)$`, 'im');
  const match = String(output || '').match(pattern);
  return match ? { exists: true, value: match[1].trim() } : { exists: false, value: '' };
}

async function readRegistryValue(name) {
  const output = await runRegistry(['query', INTERNET_SETTINGS_KEY, '/v', name], { allowMissing: true });
  return parseRegistryOutput(output, name);
}

async function readSystemProxy() {
  const [proxyEnable, proxyServer, proxyOverride] = await Promise.all([
    readRegistryValue('ProxyEnable'),
    readRegistryValue('ProxyServer'),
    readRegistryValue('ProxyOverride'),
  ]);
  return { proxyEnable, proxyServer, proxyOverride };
}

function setRegistryValue(name, type, value) {
  return runRegistry(['add', INTERNET_SETTINGS_KEY, '/v', name, '/t', type, '/d', String(value), '/f']);
}

function deleteRegistryValue(name) {
  return runRegistry(['delete', INTERNET_SETTINGS_KEY, '/v', name, '/f'], { allowMissing: true });
}

function restoreRegistryValue(name, type, entry) {
  return entry?.exists ? setRegistryValue(name, type, entry.value) : deleteRegistryValue(name);
}

async function enableSystemProxy(host, port) {
  if (process.platform !== 'win32') return { ok: false, error: '系统代理模式仅支持 Windows' };
  if (!ownedSnapshot) ownedSnapshot = await readSystemProxy();
  const server = `${String(host || '127.0.0.1')}:${Number(port) || 7890}`;
  await Promise.all([
    setRegistryValue('ProxyServer', 'REG_SZ', server),
    setRegistryValue('ProxyOverride', 'REG_SZ', '<local>;localhost;127.*'),
  ]);
  await setRegistryValue('ProxyEnable', 'REG_DWORD', 1);
  return { ok: true, enabled: true, server };
}

async function disableSystemProxy() {
  if (process.platform !== 'win32' || !ownedSnapshot) return { ok: true, restored: false };
  const snapshot = ownedSnapshot;
  await Promise.all([
    restoreRegistryValue('ProxyServer', 'REG_SZ', snapshot.proxyServer),
    restoreRegistryValue('ProxyOverride', 'REG_SZ', snapshot.proxyOverride),
  ]);
  await restoreRegistryValue('ProxyEnable', 'REG_DWORD', snapshot.proxyEnable);
  ownedSnapshot = null;
  return { ok: true, restored: true };
}

module.exports = {
  disableSystemProxy,
  enableSystemProxy,
  parseRegistryOutput,
  readSystemProxy,
};

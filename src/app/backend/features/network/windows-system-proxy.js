'use strict';

const { execFile } = require('child_process');

const INTERNET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const INTERNET_SETTINGS_POLICY_KEY = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const REG_TIMEOUT_MS = 5000;
const PROXY_NOTIFY_TIMEOUT_MS = 5000;
const SYSTEM_PROXY_NOTIFY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AiFreeProxyNotify {
  [DllImport("wininet.dll", SetLastError=true)]
  public static extern bool InternetSetOption(IntPtr hInternet, uint option, IntPtr buffer, uint length);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);
}
"@
[AiFreeProxyNotify]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
[AiFreeProxyNotify]::InternetSetOption([IntPtr]::Zero, 95, [IntPtr]::Zero, 0) | Out-Null
$result = [IntPtr]::Zero
[AiFreeProxyNotify]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [IntPtr]::Zero, 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', 2, 5000, [ref]$result) | Out-Null
`;
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

async function readRegistryValueAtKey(key, name) {
  const output = await runRegistry(['query', key, '/v', name], { allowMissing: true });
  return parseRegistryOutput(output, name);
}

async function readRegistryValue(name) {
  return readRegistryValueAtKey(INTERNET_SETTINGS_KEY, name);
}

async function readSystemProxy() {
  const [proxyEnable, proxyServer, proxyOverride, autoDetect, autoConfigUrl] = await Promise.all([
    readRegistryValue('ProxyEnable'),
    readRegistryValue('ProxyServer'),
    readRegistryValue('ProxyOverride'),
    readRegistryValue('AutoDetect'),
    readRegistryValue('AutoConfigURL'),
  ]);
  return { proxyEnable, proxyServer, proxyOverride, autoDetect, autoConfigUrl };
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

function notifySystemProxyChanged() {
  return new Promise((resolve) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', SYSTEM_PROXY_NOTIFY_SCRIPT,
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: PROXY_NOTIFY_TIMEOUT_MS,
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ ok: true });
        return;
      }
      resolve({
        ok: false,
        error: String(stderr || stdout || error.message).trim() || 'Windows 代理配置刷新通知失败',
      });
    });
  });
}

function formatProxyNotificationWarning(result) {
  return result?.ok === true ? '' : `，系统刷新通知失败：${result?.error || '未知错误'}`;
}

async function enableSystemProxy(host, port) {
  if (process.platform !== 'win32') return { ok: false, error: '系统代理模式仅支持 Windows' };
  let proxyPolicy = null;
  try {
    proxyPolicy = await readRegistryValueAtKey(INTERNET_SETTINGS_POLICY_KEY, 'ProxySettingsPerUser');
  } catch (_) {}
  if (proxyPolicy?.exists && Number.parseInt(proxyPolicy.value, 0) === 0) {
    return { ok: false, error: '当前 Windows 由组策略按计算机管理代理，无法写入当前用户系统代理' };
  }
  if (!ownedSnapshot) ownedSnapshot = await readSystemProxy();
  const server = `${String(host || '127.0.0.1')}:${Number(port) || 7890}`;
  await Promise.all([
    setRegistryValue('ProxyServer', 'REG_SZ', server),
    setRegistryValue('ProxyOverride', 'REG_SZ', '<local>;localhost;127.*'),
    setRegistryValue('AutoDetect', 'REG_DWORD', 0),
    deleteRegistryValue('AutoConfigURL'),
  ]);
  await setRegistryValue('ProxyEnable', 'REG_DWORD', 1);
  const notification = await notifySystemProxyChanged();
  return {
    ok: true,
    enabled: true,
    server,
    ...(notification.ok ? {} : { warning: formatProxyNotificationWarning(notification) }),
  };
}

async function disableSystemProxy() {
  if (process.platform !== 'win32' || !ownedSnapshot) return { ok: true, restored: false };
  const snapshot = ownedSnapshot;
  await Promise.all([
    restoreRegistryValue('ProxyServer', 'REG_SZ', snapshot.proxyServer),
    restoreRegistryValue('ProxyOverride', 'REG_SZ', snapshot.proxyOverride),
    restoreRegistryValue('AutoDetect', 'REG_DWORD', snapshot.autoDetect),
    restoreRegistryValue('AutoConfigURL', 'REG_SZ', snapshot.autoConfigUrl),
  ]);
  await restoreRegistryValue('ProxyEnable', 'REG_DWORD', snapshot.proxyEnable);
  ownedSnapshot = null;
  const notification = await notifySystemProxyChanged();
  return {
    ok: true,
    restored: true,
    ...(notification.ok ? {} : { warning: formatProxyNotificationWarning(notification) }),
  };
}

module.exports = {
  disableSystemProxy,
  enableSystemProxy,
  parseRegistryOutput,
  readSystemProxy,
};

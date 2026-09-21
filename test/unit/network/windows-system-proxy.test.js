'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const childProcess = require('node:child_process');

function loadControllerWithRegistryMock(responses, calls) {
  const originalExecFile = childProcess.execFile;
  childProcess.execFile = (command, args, options, callback) => {
    calls.push({ command, args, options });
    const response = responses(args) || {};
    setImmediate(() => callback(response.error || null, response.stdout || '', response.stderr || ''));
  };
  const target = require.resolve('../../../src/app/backend/features/network/windows-system-proxy');
  delete require.cache[target];
  const controller = require(target);
  childProcess.execFile = originalExecFile;
  return controller;
}

test('registry output parser handles DWORD, text and missing values', () => {
  const target = require('../../../src/app/backend/features/network/windows-system-proxy');
  assert.deepEqual(target.parseRegistryOutput('    ProxyEnable    REG_DWORD    0x1\r\n', 'ProxyEnable'), {
    exists: true, value: '0x1',
  });
  assert.deepEqual(target.parseRegistryOutput('', 'ProxyServer'), { exists: false, value: '' });
});

test('Windows system proxy uses lightweight reg.exe calls and restores prior values', {
  skip: process.platform !== 'win32',
}, async () => {
  const calls = [];
  const values = {
    ProxyEnable: ['REG_DWORD', '0x0'],
    ProxyServer: ['REG_SZ', 'old.proxy:8080'],
  };
  const controller = loadControllerWithRegistryMock((args) => {
    if (args[0] !== 'query') return {};
    const name = args[args.indexOf('/v') + 1];
    const entry = values[name];
    if (!entry) return { error: Object.assign(new Error('missing'), { code: 1 }) };
    return { stdout: `    ${name}    ${entry[0]}    ${entry[1]}\r\n` };
  }, calls);

  assert.deepEqual(await controller.enableSystemProxy('127.0.0.1', 17890), {
    ok: true, enabled: true, server: '127.0.0.1:17890',
  });
  assert.equal(calls.filter((call) => call.command === 'reg.exe').length > 0, true);
  assert.equal(calls.some((call) => call.command === 'powershell.exe'), true);
  assert.ok(calls.some((call) => call.args.includes('127.0.0.1:17890')));

  assert.deepEqual(await controller.disableSystemProxy(), { ok: true, restored: true });
  assert.ok(calls.some((call) => call.args[0] === 'delete' && call.args.includes('ProxyOverride')));
  assert.ok(calls.some((call) => call.args.includes('old.proxy:8080')));
});

test('registry timeout or write failure is returned instead of hanging startup', {
  skip: process.platform !== 'win32',
}, async () => {
  const calls = [];
  const failure = Object.assign(new Error('operation timed out'), { code: 'ETIMEDOUT' });
  const controller = loadControllerWithRegistryMock((args) => (
    args[0] === 'query' ? { stdout: '' } : { error: failure }
  ), calls);
  await assert.rejects(controller.enableSystemProxy('127.0.0.1', 7890), /operation timed out/);
  assert.equal(calls.every((call) => call.options.timeout === 5000), true);
});

test('machine proxy policy returns an actionable error instead of claiming success', {
  skip: process.platform !== 'win32',
}, async () => {
  const calls = [];
  const controller = loadControllerWithRegistryMock((args) => {
    if (args[0] !== 'query') return {};
    if (args[1].includes('Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings')) {
      return { stdout: '    ProxySettingsPerUser    REG_DWORD    0x0\r\n' };
    }
    return { error: Object.assign(new Error('missing'), { code: 1 }) };
  }, calls);

  const result = await controller.enableSystemProxy('127.0.0.1', 7890);
  assert.equal(result.ok, false);
  assert.match(result.error, /组策略按计算机管理代理/);
  assert.equal(calls.some((call) => call.args[0] === 'add'), false);
});

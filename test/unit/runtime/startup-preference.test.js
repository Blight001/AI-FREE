const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isStartMinimizedArg,
  readStartupSettings,
  updateStartupSettings,
} = require('../../../src/app/backend/features/window/startup-preference');

test('开机启动设置默认关闭并识别最小化参数', () => {
  assert.deepEqual(readStartupSettings(() => ({})), {
    openAtLogin: false,
    startMinimized: false,
  });
  assert.equal(isStartMinimizedArg(['--foo', '--start-minimized']), true);
  assert.equal(isStartMinimizedArg(['--foo']), false);
});

test('开机启动设置同时持久化自启与最小化状态', () => {
  let savedStore = null;
  let appliedLoginSettings = null;
  const result = updateStartupSettings({
    app: {
      isPackaged: true,
      setLoginItemSettings: (settings) => { appliedLoginSettings = settings; },
    },
    readStoreConfigSafe: () => ({ existing: true }),
    writeStoreConfigSafe: (next) => { savedStore = next; return true; },
    payload: { openAtLogin: true, startMinimized: true },
    options: { platform: 'win32', execPath: 'C:/AI-FREE/AI-FREE.exe', isPackaged: true },
  });

  assert.deepEqual(result, {
    ok: true,
    data: {
      openAtLogin: true,
      startMinimized: true,
      supported: true,
    },
  });
  assert.deepEqual(appliedLoginSettings, {
    openAtLogin: true,
    path: 'C:/AI-FREE/AI-FREE.exe',
    args: ['--start-minimized'],
  });
  assert.deepEqual(savedStore, {
    existing: true,
    startupSettings: {
      openAtLogin: true,
      startMinimized: true,
    },
  });
});

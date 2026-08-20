'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDeviceHallUpdateChecker, validatedReleasePage } = require(
  '../../../src/app/main/features/updates/device-hall-update-checker',
);

test('统一更新检查每个服务器版本只询问一次并打开设备大厅', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aifree-device-update-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const opened = [];
  let confirms = 0;
  const checker = createDeviceHallUpdateChecker({
    filePath: path.join(dir, 'notices.json'),
    version: '1.0.0',
    fetch: async (url) => ({
      ok: true,
      json: async () => ({
        update_available: true,
        latest_version: '2.0.0',
        release_notes: 'test',
        release_page_url: 'https://heysure.test/?device-hall=1',
        requested: url,
      }),
    }),
    confirmDownload: async () => { confirms += 1; return true; },
    openExternal: async (url) => opened.push(url),
  });

  await checker.check('https://heysure.test');
  await checker.check('https://heysure.test');

  assert.equal(confirms, 1);
  assert.deepEqual(opened, ['https://heysure.test/?device-hall=1']);
});

test('拒绝当前服务器之外的更新页', () => {
  assert.throws(
    () => validatedReleasePage('https://heysure.test', 'https://other.test/download'),
    /当前 HeySure 服务器/,
  );
});

test('检查失败被收敛且不向调用方抛出', async () => {
  const warnings = [];
  const checker = createDeviceHallUpdateChecker({
    filePath: path.join(os.tmpdir(), `aifree-notice-${process.pid}.json`),
    fetch: async () => { throw new Error('offline'); },
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
  });
  await checker.check('https://heysure.test');
  assert.match(warnings[0], /不影响连接/);
});

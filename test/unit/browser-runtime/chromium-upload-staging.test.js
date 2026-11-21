'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ChromiumLaunchResources } = require('../../../src/app/backend/browser-runtime/chromium-launch-resources');
const { CONFIRMED_UPLOAD_FILES } = require('../../../src/app/backend/browser-runtime/chromium-upload-staging');
const { selectRuntimeFiles } = require('../../../src/app/backend/browser-runtime/runtime-file-selection');

async function fixture(t, contents, simulateArm) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-free-upload-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile');
  const workspace = path.join(root, 'workspace');
  await Promise.all([fs.mkdir(profile), fs.mkdir(workspace)]);
  const file = path.join(workspace, '素材.txt');
  await fs.writeFile(file, contents);
  const resources = new ChromiumLaunchResources({ root: profile }, null, null);
  const requests = [];
  const instance = { child: { pid: process.pid }, resources, commandClient: {
    async send(name, request) {
      requests.push({ name, request });
      return simulateArm ? simulateArm(request) : { result: { selectionId: 'selected' } };
    },
  } };
  const runtime = { getReadyInstance: () => instance, enqueueProfileOperation: (_id, fn) => fn() };
  const confirmed = { absolutePath: await fs.realpath(file), size: Buffer.byteLength(contents),
    sha256: createHash('sha256').update(contents).digest('hex') };
  const arm = () => selectRuntimeFiles(runtime, 'test', { paths: [confirmed.absolutePath], [CONFIRMED_UPLOAD_FILES]: [confirmed] },
    { sandboxDir: workspace, expectedPageToken: 'page' });
  return { arm, workspace, file, profile, resources, requests };
}

for (const original of ['confirmed contents', '']) {
  test(`Chromium reads confirmed ${original ? 'bytes' : 'empty file'} after the workspace original changes`, async (t) => {
    const f = await fixture(t, original);
    await f.arm();
    const [copy] = f.requests[0].request.payload.paths;
    assert.equal(path.basename(copy), path.basename(f.file));
    assert.notEqual(path.dirname(copy), f.workspace);
    await fs.writeFile(f.file, 'different bytes');
    await f.resources.dispose({ processExited: false });
    assert.equal(await fs.readFile(copy, 'utf8'), original);
    await f.resources.dispose({ processExited: true });
    assert.deepEqual(await fs.readdir(f.profile), []);
  });
}

test('a same-size replacement before staging never arms the browser or leaves a copy', async (t) => {
  const f = await fixture(t, 'initial');
  await fs.writeFile(f.file, 'changed');
  await assert.rejects(f.arm, { code: 'UPLOAD_FILE_CHANGED' });
  assert.deepEqual(f.requests, []);
  assert.deepEqual(await fs.readdir(f.profile), []);
});

test('a refused or timed-out chooser arm deletes its unused copy', async (t) => {
  for (const refused of [true, false]) {
    const f = await fixture(t, 'confirmed', () => {
      if (refused) return { result: { success: false, errorCode: 'BROWSER_TARGET_CHANGED' } };
      throw Object.assign(new Error('timed out'), { code: 'COMMAND_TIMEOUT' });
    });
    if (refused) assert.equal((await f.arm()).result.errorCode, 'BROWSER_TARGET_CHANGED');
    else await assert.rejects(f.arm, { code: 'COMMAND_TIMEOUT' });
    assert.deepEqual(await fs.readdir(f.profile), []);
  }
});

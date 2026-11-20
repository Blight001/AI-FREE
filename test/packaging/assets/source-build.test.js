'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

const { buildRoot, buildSource, moduleKindFor, stampExtensionServiceWorkers, withPackagedSource } = require('../../../scripts/build-source');

test('内置 AIX 更新时不打开网页，并保留下载栏设置', (t) => {
  const extension = 'aixdownloader-9.0.58';
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aix-source-build-'));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const relativeDir = path.join('src', 'assets', 'extensions', extension);
  const originalDir = path.resolve(__dirname, '../../..', relativeDir);
  const outputDir = path.join(outputRoot, relativeDir);
  fs.mkdirSync(outputDir, { recursive: true });
  for (const name of ['manifest.json', 'background.js']) {
    fs.copyFileSync(path.join(originalDir, name), path.join(outputDir, name));
  }
  stampExtensionServiceWorkers(outputRoot);
  const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
  const worker = fs.readFileSync(path.join(outputDir, manifest.background.service_worker), 'utf8');
  const listeners = [];
  const openedTabs = [];
  const shelfStates = [];
  const stub = new Proxy(() => stub, { get: () => stub });
  const withStub = (api) => new Proxy(api, { get: (target, key) => target[key] ?? stub });
  const chrome = withStub({
    runtime: withStub({ onInstalled: { addListener: (listener) => listeners.push(listener) } }),
    tabs: withStub({ create: (tab) => openedTabs.push(tab) }),
    downloads: withStub({ setShelfEnabled: (state) => shelfStates.push(state) }),
  });
  const context = { chrome, importScripts() {}, console, URL };
  context.self = context;
  vm.runInNewContext(worker, context, { timeout: 2000 });
  assert.ok(listeners.length > 0);
  for (const listener of listeners) listener({ reason: 'install' });
  assert.deepEqual(openedTabs, []);
  assert.deepEqual(shelfStates, []);
  for (const listener of listeners) listener({ reason: 'update' });
  assert.deepEqual(openedTabs, []);
  assert.deepEqual(shelfStates, [true]);
});

test('统一源码构建按 Electron 进程边界选择模块格式', () => {
  assert.equal(moduleKindFor('app/backend/main.ts'), 'commonjs');
  assert.equal(moduleKindFor('app/preload/index.ts'), 'commonjs');
  assert.equal(moduleKindFor('app/frontend/sidebar/client/bootstrap.ts'), 'esmodule');
  assert.equal(moduleKindFor('app/frontend/renderer/index.ts'), 'esmodule');
});

test('统一源码构建生成可加载主进程模块和可追踪 manifest', () => {
  const manifest = buildSource();
  const manifestPath = path.join(buildRoot, 'build-manifest.json');
  assert.equal(fs.existsSync(manifestPath), true);
  assert.equal(manifest.mainFormat, 'commonjs');
  assert.equal(manifest.rendererFormat, 'esmodule');
  assert.match(manifest.sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(manifest.extensionServiceWorkers.some((entry) => entry.extension === 'browser_automation'), false);
  const registryPath = path.join(buildRoot, 'src/app/backend/features/ai-chat/chat-run-registry.js');
  delete require.cache[require.resolve(registryPath)];
  assert.equal(typeof require(registryPath).createChatRunRegistry, 'function');
  assertEnvironmentAssets(buildRoot);
});

function assertEnvironmentAssets(root) {
  const template = path.join(root, 'src/assets/browser-environment/runtime-template.js');
  assert.equal(fs.existsSync(template), true);
  const modulePath = path.join(root, 'src/app/backend/browser-runtime/browser-environment-script.js');
  const script = require(modulePath).buildBrowserEnvironmentScript({ os: 'mac', cpu: 8 });
  const context = { navigator: {} };
  vm.runInNewContext(script, context);
  assert.equal(context.navigator.hardwareConcurrency, 8);
  assert.equal(context.navigator.userAgentData.platform, 'macOS');
}

test('重建开发源码不影响预打包输入，打包成功或失败后均清理临时目录', async () => {
  const readme = path.join('src', 'app', 'README.md');
  let packagedRoot;
  await withPackagedSource(async (root) => {
    packagedRoot = root;
    assert.notEqual(root, buildRoot);
    assertEnvironmentAssets(root);
    const before = fs.readFileSync(path.join(root, readme));
    buildSource();
    assert.deepEqual(fs.readFileSync(path.join(root, readme)), before);
    assert.deepEqual(fs.readFileSync(path.join(buildRoot, readme)), before);
  });
  assert.equal(fs.existsSync(packagedRoot), false);

  await assert.rejects(withPackagedSource(async (root) => {
    packagedRoot = root;
    throw new Error('packager failed');
  }), /packager failed/);
  assert.equal(fs.existsSync(packagedRoot), false);
});

test('开发、测试和 Windows 打包脚本共享 prepare:source 入口', () => {
  const projectDir = path.resolve(__dirname, '../../..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
  for (const name of ['start', 'start:electron', 'start:dev', 'start:chromium', 'build', 'build:portable', 'pretest']) {
    assert.match(packageJson.scripts[name], /prepare:source/);
  }
  const sourceMapping = packageJson.build.files.find((entry) => entry && typeof entry === 'object');
  assert.equal(sourceMapping.from, '.generated/app/src');
  assert.equal(sourceMapping.to, 'src');
});

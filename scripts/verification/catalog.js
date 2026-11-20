'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { interactionChecks } = require('./interactions');

const projectRoot = path.resolve(__dirname, '../..');
const nativeBinding = 'native/browser-host/build/Release/browser_host.node';

function npmCli() {
  return process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
}

function step(id, description, args, options = {}) {
  return { id, description, args, timeoutMs: 300000, requiredFiles: [], windows: false, ...options };
}

function npmStep(id, script, description, options = {}) {
  return step(id, description, [npmCli(), 'run', script], {
    ...options, requiredFiles: [npmCli(), ...(options.requiredFiles || [])],
  });
}

function catalog() {
  const entries = [
    step('patch-inventory', '检查补丁队列、哈希与影响文件；不证明能够重放', ['scripts/check-chromium-patches.js']),
    step('patch-replay', '在临时 Git 索引顺序应用补丁；不修改 Chromium 工作区',
      ['scripts/check-chromium-patches.js', '--replay'], { timeoutMs: 900000 }),
    npmStep('prepare', 'prepare:source', '生成 .generated/app'),
    npmStep('guardrails', 'guardrails', '复杂度、尺寸和类型零基线门禁'),
    npmStep('verify', 'verify', '源码格式、lint、类型、架构、测试、覆盖率与生成态', { timeoutMs: 1800000 }),
    npmStep('tests', 'test', '独立执行项目测试；源码门禁失败时仍可检查行为', {
      timeoutMs: 1800000, after: ['prepare'],
    }),
    npmStep('native-build', 'build:native-host', '编译 Windows 原生宿主', { windows: true }),
    step('native-tests', '原生导出接口与 DPI；不运行空的嵌入占位测试',
      ['--test', 'native/browser-host/test/host_window.test.js'], {
        windows: true, after: ['native-build'], requiredFiles: [nativeBinding, 'native/browser-host/build/Release/dpi_scaling_test.exe'],
      }),
    step('native-load', '在真实 Electron 中加载原生宿主',
      ['scripts/run-electron.js', 'scripts/check-native-host-load.js'], {
        windows: true, after: ['native-build'], requiredFiles: [nativeBinding, 'node_modules/electron/dist/electron.exe'],
      }),
    npmStep('acceptance', 'test:acceptance', '现有集成验收入口', {
      windows: true, timeoutMs: 900000, after: ['prepare', 'native-build'],
    }),
    npmStep('embedded-policy', 'check:chromium-embedded-policy', '内核嵌入策略静态约束'),
    npmStep('packaged', 'check:packaged-runtime', '检查已有 win-unpacked 资源；不证明与当前源码一致', {
      requiredFiles: ['appbuild/win-unpacked/resources/app.asar'],
    }),
  ];
  const interactive = interactionChecks();
  return [...entries, ...interactive];
}

const suites = {
  inventory: ['patch-inventory'],
  patches: ['patch-inventory', 'patch-replay'],
  source: ['prepare', 'guardrails', 'verify'],
  tests: ['prepare', 'tests'],
  native: ['native-build', 'native-tests', 'native-load'],
  acceptance: ['prepare', 'acceptance', 'embedded-policy'],
  chromium: ['chromium-phase3', 'chromium-alignment', 'native-workflow', 'chromium-media'],
  packaged: ['packaged'],
  interactions: ['prepare', 'native-build', ...interactionChecks().map((entry) => entry.id)],
  full: ['patch-inventory', 'patch-replay', 'prepare', 'guardrails', 'verify', 'native-build',
    'native-tests', 'native-load', 'acceptance', 'embedded-policy', 'chromium-phase3',
    'chromium-alignment', 'native-workflow', 'chromium-media', 'remote-browser-peer-generated',
    'source-pages', 'generated-pages', 'packaged-sidebar', 'remote-browser-peer-packaged', 'packaged'],
};

function verificationPlan(suite, options = {}) {
  if (!Object.hasOwn(suites, suite)) throw new Error(`Unknown verification suite: ${suite}`);
  const steps = catalog();
  let plan = suites[suite].map((id) => steps.find((entry) => entry.id === id));
  if (options.only) {
    if (suite !== 'interactions' || !Array.isArray(options.only) || !options.only.length) throw new Error('INTERACTION_SELECTION_REQUIRED');
    const selected = new Set(options.only);
    for (const id of selected) {
      if (!interactionChecks().some((entry) => entry.id === id)) throw new Error(`UNKNOWN_INTERACTION: ${id}`);
    }
    const dependencies = new Set(plan.filter((entry) => selected.has(entry.id)).flatMap((entry) => entry.after || []));
    plan = plan.filter((entry) => dependencies.has(entry.id) || selected.has(entry.id));
  }
  return plan;
}

function unmetRequirement(entry, root = projectRoot, platform = process.platform) {
  if (entry.windows && platform !== 'win32') return 'WINDOWS_REQUIRED';
  const missing = entry.requiredFiles.filter((file) => !fs.existsSync(path.resolve(root, file)));
  return missing.length ? `MISSING_PREREQUISITE: ${missing.join(', ')}` : '';
}

function unmetDependency(entry, results) {
  const failed = (entry.after || []).find((id) => results.some((result) => result.id === id && result.status !== 'passed'));
  return failed ? `DEPENDENCY_NOT_PASSED: ${failed}` : '';
}

module.exports = { projectRoot, suites, catalog, verificationPlan, unmetRequirement, unmetDependency };

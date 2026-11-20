const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const { prepareChromiumSessionRecovery } = require('./chromium-session-recovery');
const { prepareChromiumPreflight } = require('./chromium-launch-preflight');
const { ensureChromiumSandboxAccess } = require('./chromium-sandbox-access');
const { enforceLocalModelDisabled } = require('./chromium-local-model-policy');
const {
  buildChromiumProfileArgs,
  buildChromiumUserAgentMetadataArgument,
} = require('./chromium-profile-args');
const { applyChromiumSessionStartupPolicy } = require('./chromium-startup-preferences');
const { attachChromiumLaunchLogging } = require('./chromium-launch-log');
const { createChromiumPerformanceSpan } = require('./chromium-performance');
const { waitForChromiumPreflightWarmup } = require('./chromium-preflight-warmup');
const { callOptional, firstText } = require('../../shared/safe-values');

const FORBIDDEN_SWITCHES = new Set([
  '--no-sandbox',
  '--single-process',
  '--disable-web-security',
  '--disable-site-isolation-trials',
  '--allow-running-insecure-content',
]);

const GOOGLE_CREDENTIAL_ENV_MAP = Object.freeze({
  AI_FREE_GOOGLE_API_KEY: 'GOOGLE_API_KEY',
  AI_FREE_GOOGLE_CLIENT_ID: 'GOOGLE_DEFAULT_CLIENT_ID',
  AI_FREE_GOOGLE_CLIENT_SECRET: 'GOOGLE_DEFAULT_CLIENT_SECRET',
});

function text(...values) {
  return firstText(...values).trim();
}

function buildChromiumEnvironment(baseEnv = process.env, overrides = {}) {
  const environment = { ...baseEnv, ...overrides };
  for (const [aiFreeName, chromiumName] of Object.entries(GOOGLE_CREDENTIAL_ENV_MAP)) {
    const chromiumValue = String(environment[chromiumName] || '').trim();
    const aiFreeValue = String(environment[aiFreeName] || '').trim();
    if (!chromiumValue && aiFreeValue) environment[chromiumName] = aiFreeValue;
  }
  return environment;
}

function normalizeExecutableCandidate(value) {
  const candidate = String(value || '').trim().replace(/^"|"$/g, '');
  return candidate ? path.resolve(candidate) : '';
}

function getSystemChromiumCandidates(env = process.env) {
  const programFiles = String(env.ProgramFiles || '').trim();
  const programFilesX86 = String(env['ProgramFiles(x86)'] || '').trim();
  const localAppData = String(env.LOCALAPPDATA || '').trim();
  const joinIfRoot = (root, ...parts) => root ? path.join(root, ...parts) : '';
  return [
    joinIfRoot(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    joinIfRoot(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    joinIfRoot(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    joinIfRoot(programFiles, 'Chromium', 'Application', 'chrome.exe'),
    joinIfRoot(programFilesX86, 'Chromium', 'Application', 'chrome.exe'),
    joinIfRoot(localAppData, 'Chromium', 'Application', 'chrome.exe'),
    joinIfRoot(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    joinIfRoot(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
}

function resolveChromiumExecutable(options = {}) {
  const explicitResourcesPath = String(options.resourcesPath || '').trim();
  const resourcesPath = explicitResourcesPath || process.resourcesPath || '';
  const profile = options.profile || {};
  const prototypeMode = String(process.env.AI_FREE_CHROMIUM_HANDSHAKE || '').trim().toLowerCase() === 'prototype';
  const formalCandidates = [
    resourcesPath && path.join(resourcesPath, 'chromium', 'ai-free-browser.exe'),
    !explicitResourcesPath && (!process.resourcesPath || process.resourcesPath === resourcesPath)
      ? path.join(process.cwd(), 'resources', 'chromium', 'ai-free-browser.exe')
      : '',
  ];
  const candidates = [
    ...formalCandidates,
    ...(prototypeMode ? [
      resourcesPath && path.join(resourcesPath, 'chromium', 'chrome.exe'),
      options.executablePath,
      process.env.AI_FREE_CHROMIUM_PATH,
      ...getSystemChromiumCandidates(),
    ] : []),
  ].map(normalizeExecutableCandidate).filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return found;
  const error = /** @type {Error & {code?: string, candidates?: string[]}} */ (new Error(prototypeMode
    ? '未找到可用于原型验证的 Chromium/Chrome/Edge'
    : '未找到打包的 AI-FREE Chromium Fork：resources/chromium/ai-free-browser.exe（正式模式禁止使用系统 Chrome 或外部路径）'));
  error.code = 'CHROMIUM_EXECUTABLE_NOT_FOUND';
  error.candidates = candidates;
  throw error;
}

function assertSafeChromiumArgs(args = []) {
  for (const rawArg of args) {
    const arg = String(rawArg || '').trim().toLowerCase();
    const switchName = arg.split('=')[0];
    if (FORBIDDEN_SWITCHES.has(switchName)) {
      const error = /** @type {Error & {code?: string}} */ (new Error(`禁止使用不安全的 Chromium 参数: ${switchName}`));
      error.code = 'FORBIDDEN_CHROMIUM_SWITCH';
      throw error;
    }
    if (switchName === '--remote-debugging-address' && !/=(127\.0\.0\.1|localhost|::1)$/.test(arg)) {
      const error = /** @type {Error & {code?: string}} */ (new Error('Chromium 调试地址只能绑定回环接口'));
      error.code = 'UNSAFE_DEBUG_ADDRESS';
      throw error;
    }
  }
}

function buildChromiumArgs(options = {}) {
  const profile = options.profile || {};
  const paths = options.paths || {};
  const bounds = options.bounds || {};
  const runtimeProfileId = String(options.runtimeProfileId || profile.profileId || '').trim();
  const args = [
    `--user-data-dir=${paths.chromiumData}`,
    `--download-default-directory=${paths.downloads}`,
    `--hs-profile-id=${runtimeProfileId}`,
    `--hs-runtime-pipe=${options.pipeName}`,
    `--hs-runtime-token=${options.launchToken}`,
    '--hs-embed-mode=child-window',
    '--no-first-run',
    '--no-default-browser-check',
    // The embedded runtime is updated by AI-FREE itself. Chromium's own
    // component/model updater can otherwise download hundreds of megabytes
    // through the currently selected proxy while every page is idle.
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-session-crashed-bubble',
  ];
  if (profile.lowSpecMode !== true) args.push('--disable-backgrounding-occluded-windows');
  args.push(...buildChromiumProfileArgs(options, profile, bounds));
  args.push(...(Array.isArray(profile.extraArgs) ? profile.extraArgs : []));
  const userAgentMetadataArgument = buildChromiumUserAgentMetadataArgument(profile.environmentSettings);
  if (userAgentMetadataArgument) args.push(userAgentMetadataArgument);
  const modelSafeArgs = enforceLocalModelDisabled(args);
  modelSafeArgs.push('--enable-logging=stderr');
  // Chromium 在握手完成前还是独立顶层窗口。强制放到虚拟屏幕外，且放在
  // 自定义参数之后，避免用户参数覆盖；嵌入后 native host 会重新定位。
  modelSafeArgs.push('--window-position=-32000,-32000');
  if (profile.initialUrl) modelSafeArgs.push(String(profile.initialUrl));
  assertSafeChromiumArgs(modelSafeArgs);
  return modelSafeArgs;
}

function resolveChromiumLaunchOptions(options) {
  const profile = options.profile && typeof options.profile === 'object' ? options.profile : {};
  if (profile.restoreLastSession !== true) return options;
  const recovery = prepareChromiumSessionRecovery(options.paths, options.logger);
  const fallbackUrl = text(profile.restoreFallbackUrl);
  if (recovery.restorable || !/^https?:\/\//i.test(fallbackUrl)) return options;
  callOptional(options.logger, 'warn', '[ChromiumRuntime] 未找到可恢复的活动标签，回退打开浏览器记录网址:', fallbackUrl);
  return {
    ...options,
    profile: { ...profile, initialUrl: fallbackUrl, restoreLastSession: false },
  };
}

function chromiumSpawnEnvironment(options) {
  const profile = options.profile && typeof options.profile === 'object' ? options.profile : {};
  const overrides = { ...(options.env || {}) };
  if (profile.timezoneId) overrides.TZ = String(profile.timezoneId);
  return buildChromiumEnvironment(process.env, overrides);
}

async function launchChromium(options = {}) {
  const span = createChromiumPerformanceSpan(options.logger, 'process-launch');
  try {
    const executablePath = resolveChromiumExecutable(options); span.mark('resolveExecutable');
    await waitForChromiumPreflightWarmup(executablePath); span.mark('preflightWarmupWait');
    const profileRoot = String(options.paths?.root || '').trim();
    const cacheFile = profileRoot
      ? path.join(path.dirname(profileRoot), '.chromium-sandbox-access.json')
      : '';
    const sandboxAccess = ensureChromiumSandboxAccess(executablePath, options.logger, { cacheFile });
    span.mark('sandboxAccess');
    const preflight = prepareChromiumPreflight(options, executablePath, sandboxAccess);
    span.mark('preflight');
    const launchOptions = resolveChromiumLaunchOptions(options);
    applyChromiumSessionStartupPolicy(launchOptions.paths, launchOptions.logger, launchOptions.profile); span.mark('sessionPolicy');
    const args = buildChromiumArgs(launchOptions); span.mark('arguments');
    const child = spawn(executablePath, args, {
      cwd: path.dirname(executablePath),
      windowsHide: true,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: chromiumSpawnEnvironment(options),
    });
    if (options.resources) options.resources.child = child;
    span.mark('spawn');
    const diagnostics = attachChromiumLaunchLogging({
      child, executablePath, args, logger: options.logger,
      logFilePath: options.chromiumLogPath,
      diagnosticDir: options.chromiumDiagnosticDir,
      userDataDir: options.chromiumUserDataDir,
      appVersion: options.appVersion,
      sandboxAccess,
      preflight,
      forwardOutput: forwardChromiumOutput,
      shouldIgnore: shouldIgnoreChromiumDiagnostic,
    });
    span.mark('diagnostics');
    span.finish();
    return { child, executablePath, args, diagnostics };
  } catch (error) {
    span.fail(error);
    throw error;
  }
}

// Windows 未安装特定 Winsock 服务提供程序时 Chromium 会反复输出该诊断，
// 但它不会影响 DNS、页面加载或 Runtime Bridge，避免将它淹没有效日志。
function shouldIgnoreChromiumDiagnostic(line) {
  return /WSALookupServiceBegin failed with:\s*10108\b/.test(String(line || ''));
}

/**
 * @param {any} stream
 * @param {(text: string) => void} emit
 * @param {(text: string) => boolean} [shouldIgnore]
 */
function forwardChromiumOutput(stream, emit, shouldIgnore = () => false) {
  if (!stream || typeof stream.on !== 'function') return;
  let pending = '';

  const flushLine = (line) => {
    const text = String(line || '').trimEnd();
    if (!text || shouldIgnore(text)) return;
    emit(text);
  };

  stream.on('data', (chunk) => {
    pending += String(chunk || '');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) flushLine(line);
  });
  stream.on('end', () => {
    flushLine(pending);
    pending = '';
  });
}

module.exports = {
  FORBIDDEN_SWITCHES,
  applyChromiumSessionStartupPolicy,
  assertSafeChromiumArgs,
  buildChromiumArgs,
  buildChromiumEnvironment,
  ensureChromiumSandboxAccess,
  forwardChromiumOutput,
  getSystemChromiumCandidates,
  launchChromium,
  resolveChromiumExecutable,
  shouldIgnoreChromiumDiagnostic,
};

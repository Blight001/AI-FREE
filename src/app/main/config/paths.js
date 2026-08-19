// 集中路径解析（阶段 2D-3，方案 §3.3）——散落在 bootstrap 的特殊路径推导收敛于此。
// 常规 userData 子路径仍用 app.getPath('userData') 现场拼接；这里只放
// 有非平凡判断逻辑的路径。
'use strict';

const fs = require('fs');
const path = require('path');

// 开发环境下 process.resourcesPath 指向 node_modules/electron/dist/resources，
// 而不是本应用的 resources 目录；打包版则把 Chromium fork 直接放在
// process.resourcesPath/chromium。
function resolveChromiumResourcesPath(app, options = {}) {
  if (app.isPackaged) return process.resourcesPath;

  const workingDirectory = path.resolve(options.workingDirectory || process.cwd());
  const moduleDirectory = path.resolve(options.moduleDirectory || __dirname);
  const appPath = typeof app.getAppPath === 'function' ? path.resolve(app.getAppPath()) : '';
  const candidates = [...new Set([
    path.join(workingDirectory, 'resources'),
    appPath && path.join(appPath, 'resources'),
    appPath && path.resolve(appPath, '..', '..', 'resources'),
    path.resolve(moduleDirectory, '../../../..', 'resources'),
  ].filter(Boolean))];
  return candidates.find((candidate) => (
    fs.existsSync(path.join(candidate, 'chromium', 'ai-free-browser.exe'))
  )) || candidates[0];
}

// 卡片库属于软件级数据，放在 userData/extensions 下，不随任一 Chromium Profile
// 或注入用的扩展副本一起删除。
function resolveAutomationCardCacheDir(app) {
  return path.join(app.getPath('userData'), 'extensions', 'browser_automation');
}

function findSourceRoot(startDirectory, fileSystem = fs) {
  let current = path.resolve(startDirectory);
  for (let depth = 0; depth < 6; depth += 1) {
    if (fileSystem.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(startDirectory);
}

function resolveInstallDirectory(app, options = {}) {
  if (app?.isPackaged) return path.dirname(path.resolve(app.getPath('exe')));
  const workingDirectory = path.resolve(options.workingDirectory || process.cwd());
  const appPath = typeof app?.getAppPath === 'function' ? app.getAppPath() : workingDirectory;
  return findSourceRoot(appPath || workingDirectory, options.fs || fs);
}

function resolveAiSandboxDir(app, options = {}) {
  const desktopDirectory = typeof app?.getPath === 'function' ? app.getPath('desktop') : '';
  const stableRoot = String(desktopDirectory || '').trim();
  return path.join(stableRoot || resolveInstallDirectory(app, options), 'AI-Workspace');
}

function resolveLegacyAiSandboxDir(app, options = {}) {
  return path.join(resolveInstallDirectory(app, options), 'AI-Workspace');
}

function resolveOpenCutResourcesPath(app, options = {}) {
  const fileSystem = options.fs || fs;
  if (app?.isPackaged) return path.join(process.resourcesPath || '', 'opencut');
  const workingDirectory = path.resolve(options.workingDirectory || process.cwd());
  const moduleDirectory = path.resolve(options.moduleDirectory || __dirname);
  const appPath = typeof app?.getAppPath === 'function' ? path.resolve(app.getAppPath()) : '';
  const candidates = [...new Set([
    path.join(workingDirectory, 'resources', 'opencut'),
    appPath && path.join(appPath, 'resources', 'opencut'),
    appPath && path.resolve(appPath, '..', '..', 'resources', 'opencut'),
    path.resolve(moduleDirectory, '../../../..', 'resources', 'opencut'),
  ].filter(Boolean))];
  return candidates.find((candidate) => (
    fileSystem.existsSync(path.join(candidate, 'web', 'index.html'))
  )) || candidates[0];
}

function resolveOpenCutWebRoot(app, options = {}) {
  return path.join(resolveOpenCutResourcesPath(app, options), 'web');
}

function resolveOpenCutDataDir(app, options = {}) {
  const userData = typeof app?.getPath === 'function' ? app.getPath('userData') : '';
  const root = String(options.userDataDir || userData || '').trim();
  return path.join(root || resolveInstallDirectory(app, options), 'opencut', 'projects');
}

module.exports = {
  resolveAiSandboxDir,
  resolveLegacyAiSandboxDir,
  resolveAutomationCardCacheDir,
  resolveChromiumResourcesPath,
  resolveInstallDirectory,
  resolveOpenCutDataDir,
  resolveOpenCutResourcesPath,
  resolveOpenCutWebRoot,
};

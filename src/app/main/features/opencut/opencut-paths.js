'use strict';

const path = require('path');
const {
  resolveOpenCutDataDir,
  resolveOpenCutResourcesPath,
  resolveOpenCutWebRoot,
} = require('../../config/paths');

function resolveWorkspaceMediaPath(inputPath, workspaceDir) {
  const raw = String(inputPath || '').trim();
  if (!raw) throw new Error('请提供本机素材路径 path');
  if (path.isAbsolute(raw)) return path.resolve(raw);
  const root = path.resolve(String(workspaceDir || ''));
  if (!root) throw new Error('相对路径需要 AI-Workspace');
  const target = path.resolve(root, raw);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('素材路径超出 AI 工作区');
  }
  return target;
}

module.exports = {
  resolveOpenCutDataDir,
  resolveOpenCutResourcesPath,
  resolveOpenCutWebRoot,
  resolveWorkspaceMediaPath,
};

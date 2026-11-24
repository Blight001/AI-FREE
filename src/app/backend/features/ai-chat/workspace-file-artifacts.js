'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resolveInside } = require('../../services/ai-sandbox-file-tools');
const { MAX_ALLOWED_BYTES } = require('../../services/browser-download-service');

const MAX_ARTIFACTS = 16;
const DOWNLOAD_TOOLS = new Set(['browser_file', 'browser_media']);
const SCREENSHOT_TOOLS = new Set(['browser_screenshot', 'browser_observe', 'browser_action']);
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const ARTIFACT_KINDS = new Set(['image', 'video', 'audio', 'text', 'binary']);

function normalizeArtifactPath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes(':')) return '';
  const normalized = value.replace(/\\/g, '/');
  return normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\0'))
    ? '' : normalized;
}

function artifactMaximumBytes(toolName) {
  if (SCREENSHOT_TOOLS.has(toolName)) return MAX_SCREENSHOT_BYTES;
  if (DOWNLOAD_TOOLS.has(toolName)) return MAX_ALLOWED_BYTES;
  return 0;
}

function normalizeFileArtifact(value) {
  const relative = normalizeArtifactPath(value?.path);
  const maxBytes = artifactMaximumBytes(value?.toolName);
  if (!relative || !maxBytes || !ARTIFACT_KINDS.has(value?.kind)) return null;
  if (!Number.isSafeInteger(value.size) || value.size < 0 || value.size > maxBytes) return null;
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(value.sha256)) return null;
  if (typeof value.toolCallId !== 'string' || !value.toolCallId.trim() || value.toolCallId.length > 256) return null;
  return {
    path: relative, name: path.posix.basename(relative), kind: value.kind, size: value.size,
    sha256: value.sha256.toLowerCase(), toolName: value.toolName, toolCallId: value.toolCallId,
  };
}

function normalizeFileArtifacts(values) {
  if (!Array.isArray(values)) return [];
  const unique = new Map();
  for (const value of values.slice(0, MAX_ARTIFACTS)) {
    const artifact = normalizeFileArtifact(value);
    if (artifact) unique.set(JSON.stringify([artifact.toolCallId, artifact.path]), artifact);
  }
  return [...unique.values()];
}

class WorkspaceArtifactError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function invalidArtifact() {
  return new WorkspaceArtifactError('ARTIFACT_INVALID', '文件产物引用无效，请重新选择文件。');
}

function assertFileArtifact(value) {
  const artifact = normalizeFileArtifact(value);
  if (!artifact) throw invalidArtifact();
  return artifact;
}

function changedArtifact() {
  return new WorkspaceArtifactError('ARTIFACT_CHANGED', '文件已更改，请重新选择文件。');
}

function unavailableArtifact() {
  return new WorkspaceArtifactError('ARTIFACT_UNAVAILABLE', '文件不可用：文件已移动、删除或无法读取。');
}

function fileIdentity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

function resolveArtifactFile(root, relative) {
  const { target } = resolveInside(root, relative);
  const real = fs.realpathSync(target);
  if (path.relative(target, real)) throw changedArtifact();
  const stat = fs.statSync(real, { bigint: true });
  if (!stat.isFile() || stat.size > BigInt(MAX_ALLOWED_BYTES)) throw invalidArtifact();
  return {
    real, stat: { size: Number(stat.size), mtimeMs: Number(stat.mtimeNs) / 1e6 }, identity: fileIdentity(stat),
  };
}

function hashOpenFile(fd, size, captureBytes) {
  const hash = crypto.createHash('sha256');
  const prefix = Buffer.alloc(Math.min(size, captureBytes));
  const chunk = Buffer.alloc(Math.min(size, 256 * 1024));
  for (let offset = 0; offset < size;) {
    const bytes = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
    if (!bytes) throw changedArtifact();
    hash.update(chunk.subarray(0, bytes));
    if (offset < prefix.length) chunk.copy(prefix, offset, 0, Math.min(bytes, prefix.length - offset));
    offset += bytes;
  }
  return { sha256: hash.digest('hex'), prefix };
}

function inspectOpenFile(root, relative, resolved, captureBytes) {
  const fd = fs.openSync(resolved.real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (resolved.identity !== fileIdentity(fs.fstatSync(fd, { bigint: true }))) throw changedArtifact();
    const content = hashOpenFile(fd, resolved.stat.size, captureBytes);
    if (resolved.identity !== resolveArtifactFile(root, relative).identity) throw changedArtifact();
    return content;
  } finally {
    fs.closeSync(fd);
  }
}

function inspectWorkspaceFile(root, relativePath, expected = null, captureBytes = 0) {
  const relative = normalizeArtifactPath(relativePath);
  if (!relative) throw invalidArtifact();
  try {
    const resolved = resolveArtifactFile(root, relative);
    if (expected && expected.size !== resolved.stat.size) throw changedArtifact();
    const { sha256, prefix } = inspectOpenFile(root, relative, resolved, captureBytes);
    if (expected && expected.sha256 !== sha256) throw changedArtifact();
    return {
      path: relative, absolutePath: resolved.real, stat: resolved.stat, identity: resolved.identity, sha256, prefix,
    };
  } catch (error) {
    if (error instanceof WorkspaceArtifactError) throw error;
    throw unavailableArtifact();
  }
}

module.exports = {
  MAX_ARTIFACTS, MAX_SCREENSHOT_BYTES, SCREENSHOT_TOOLS, WorkspaceArtifactError, assertFileArtifact, invalidArtifact, normalizeArtifactPath,
  normalizeFileArtifact, normalizeFileArtifacts, inspectWorkspaceFile,
};

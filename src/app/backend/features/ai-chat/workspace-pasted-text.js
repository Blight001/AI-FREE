'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resolveInside } = require('../../services/ai-sandbox-file-tools');

const MAX_PASTED_TEXT_BYTES = 5 * 1024 * 1024;

function localDateSegment(date) {
  const part = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`;
}

function assertWorkspaceDirectory(root, directory) {
  const realDirectory = fs.realpathSync(directory);
  resolveInside(root, path.relative(root, realDirectory));
  return realDirectory;
}

function createWorkspacePastedTextFile(root, text, now = new Date()) {
  if (typeof text !== 'string' || !text.length) throw new Error('没有可保存的粘贴文本');
  const content = Buffer.from(text, 'utf8');
  if (content.length > MAX_PASTED_TEXT_BYTES) throw new Error('粘贴文本超过 5 MB，无法自动保存');

  const tempRoot = path.join(root, 'tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  assertWorkspaceDirectory(root, tempRoot);
  const dateDirectory = path.join(tempRoot, localDateSegment(now));
  fs.mkdirSync(dateDirectory, { recursive: true });
  const safeDirectory = assertWorkspaceDirectory(root, dateDirectory);
  const name = `pasted-text-${now.getTime()}-${crypto.randomUUID()}.txt`;
  const absolutePath = path.join(safeDirectory, name);
  fs.writeFileSync(absolutePath, content, { flag: 'wx' });
  const stat = fs.statSync(absolutePath);
  return {
    name,
    path: path.relative(root, absolutePath).replace(/\\/g, '/'),
    size: stat.size,
    modifiedAt: Number(stat.mtimeMs || 0),
  };
}

module.exports = { createWorkspacePastedTextFile };

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { MAX_ALLOWED_BYTES } = require('../services/browser-download-service');

// Internal metadata from confirmed chat uploads. JSON tool arguments cannot set it.
const CONFIRMED_UPLOAD_FILES = Symbol('confirmedUploadFiles');
const STAGING_NAME = /^\.ai-free-upload-(\d+)-(\d+)-[a-zA-Z0-9]{6}$/;
const MAX_STAGED_FILES = 128;

function stagingError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function copyConfirmedFile(source, destination, expected) {
  if (!expected || source !== expected.absolutePath || !/^[a-f0-9]{64}$/.test(expected.sha256)) {
    throw stagingError('UPLOAD_FILE_CHANGED', '文件与确认记录不一致，请重新选择');
  }
  const handle = await fs.promises.open(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const hash = createHash('sha256');
  let copied = 0;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== expected.size) throw stagingError('UPLOAD_FILE_CHANGED', '文件已变化，请重新选择');
    const output = fs.createWriteStream(destination, { mode: 0o600, flags: 'wx' });
    if (expected.size === 0) await pipeline([], output);
    else {
      await pipeline(handle.createReadStream({ autoClose: false, start: 0, end: expected.size - 1 }),
        async function* (stream) {
          for await (const chunk of stream) {
            copied += chunk.length;
            hash.update(chunk);
            yield chunk;
          }
        }, output);
    }
  } finally { await handle.close(); }
  if (copied !== expected.size || hash.digest('hex') !== expected.sha256) {
    throw stagingError('UPLOAD_FILE_CHANGED', '文件已变化，请重新选择');
  }
}

function removeStagingDirectory(root, directory) {
  const relative = path.relative(root, directory);
  if (!STAGING_NAME.test(relative) || path.relative(directory, fs.realpathSync(directory))) {
    throw stagingError('UPLOAD_STAGING_CLEANUP_FAILED', '无法验证上传副本目录');
  }
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 2 });
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

function cleanupStaleUploadStaging(profileRoot) {
  const root = fs.realpathSync(profileRoot);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const owner = entry.isDirectory() && STAGING_NAME.exec(entry.name);
    if (!owner || processIsAlive(Number(owner[1])) || processIsAlive(Number(owner[2]))) continue;
    removeStagingDirectory(root, path.join(root, entry.name));
  }
}

class ChromiumUploadStaging {
  constructor(profileRoot) {
    this.profileRoot = profileRoot;
    this.batches = new Map();
  }

  async stage(browserPid, paths, expected) {
    const size = expected.reduce((total, file) => total + file.size, 0);
    const used = [...this.batches.values()];
    const retainedBytes = used.reduce((total, item) => total + item.size, 0);
    const retainedCount = used.reduce((total, item) => total + item.count, 0);
    if (!Number.isSafeInteger(size) || size < 0 || size + retainedBytes > MAX_ALLOWED_BYTES ||
        paths.length + retainedCount > MAX_STAGED_FILES) {
      throw stagingError('UPLOAD_STAGING_LIMIT', '上传副本已达上限，请关闭并重新打开目标浏览器');
    }
    const root = fs.realpathSync(this.profileRoot);
    const directory = fs.mkdtempSync(path.join(root, `.ai-free-upload-${process.pid}-${browserPid}-`));
    this.batches.set(directory, { size, count: paths.length, root });
    const discard = () => this.discard(directory);
    try {
      const stagedPaths = [];
      for (const [index, source] of paths.entries()) {
        const folder = path.join(directory, String(index));
        await fs.promises.mkdir(folder, { mode: 0o700 });
        const destination = path.join(folder, path.basename(source));
        await copyConfirmedFile(source, destination, expected[index]);
        stagedPaths.push(destination);
      }
      return { paths: stagedPaths, discard };
    } catch (error) {
      discard();
      if (error.code === 'UPLOAD_FILE_CHANGED') throw error;
      throw stagingError('UPLOAD_STAGING_FAILED', '无法准备上传副本，请检查文件和工作区');
    }
  }

  discard(directory) {
    const batch = this.batches.get(directory);
    if (!batch) return;
    removeStagingDirectory(batch.root, directory);
    this.batches.delete(directory);
  }

  close() {
    for (const directory of this.batches.keys()) this.discard(directory);
  }
}

module.exports = { CONFIRMED_UPLOAD_FILES, ChromiumUploadStaging, cleanupStaleUploadStaging };

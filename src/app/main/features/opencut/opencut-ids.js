'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function nowMs() {
  return Date.now();
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

function safeName(name) {
  const text = String(name || '').trim()
    .replace(/[^A-Za-z0-9\u4e00-\u9fff_\-. ]/g, '_')
    .replace(/^[ ._]+|[ ._]+$/g, '')
    .slice(0, 80);
  return text || 'untitled';
}

function atomicWriteJson(filePath, payload) {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tempPath = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, target);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

class EditorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditorError';
  }
}

class FfmpegError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FfmpegError';
  }
}

module.exports = {
  EditorError,
  FfmpegError,
  atomicWriteJson,
  newId,
  nowMs,
  readJsonFile,
  safeName,
};

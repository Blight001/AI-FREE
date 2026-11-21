'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { AppError } = require('../../contracts/ipc-result');

const levelDbSuffix = '.indexeddb.leveldb';
const blobSuffix = '.indexeddb.blob';

function parseOrigin(origin) {
  const url = URL.parse(origin);
  if (!url || url.origin !== origin || !/^https?:$/.test(url.protocol) ||
      !/^(?:[a-z\d.-]+|\[[\da-f:]+\])$/.test(url.hostname) || url.hostname.includes('..')) {
    throw new AppError('SITE_ORIGIN_INVALID', '请选择一个完整的网站来源地址');
  }
  return url;
}

function originIdentifier(url) {
  return `${url.protocol.slice(0, -1)}_${url.hostname.replaceAll(':', '_')}_${url.port || 0}`;
}

function directoryOrigin(name) {
  const id = name.endsWith(levelDbSuffix) ? name.slice(0, -levelDbSuffix.length) : name;
  const match = /^(https?)_(.+)_(\d+)$/.exec(id);
  if (!match) return null;
  const [, scheme, host, port] = match;
  const authority = host.startsWith('[') ? host.replaceAll('_', ':') : host;
  const url = URL.parse(`${scheme}://${authority}${port === '0' ? '' : `:${port}`}`);
  return url && originIdentifier(url) === id ? url.origin : null;
}

async function statIfPresent(file) {
  try { return await fs.lstat(file); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function directoryIfPresent(file) {
  const stat = await statIfPresent(file);
  if (stat && !stat.isDirectory()) throw new AppError('SITE_DATABASE_PATH_INVALID', '网站数据库目录不可用');
  return Boolean(stat);
}

async function indexedDbRoot(chromiumData, create = false) {
  const defaultPartition = path.join(chromiumData, 'Default');
  const directory = path.join(defaultPartition, 'IndexedDB');
  for (const parent of [path.dirname(chromiumData), chromiumData, defaultPartition]) {
    if (!await directoryIfPresent(parent)) return null;
  }
  if (await directoryIfPresent(directory)) return directory;
  if (!create) return null;
  await fs.mkdir(directory);
  return directory;
}

async function listIndexedDbOrigins(chromiumData) {
  const dir = await indexedDbRoot(chromiumData);
  if (!dir) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return [...new Set(entries.filter(entry => entry.isDirectory()).map(entry => directoryOrigin(entry.name)).filter(Boolean))].sort();
}

function databasePaths(url) {
  const identifier = originIdentifier(url);
  return { sqlite: identifier, levelDb: identifier + levelDbSuffix, blobs: identifier + blobSuffix };
}

module.exports = { databasePaths, directoryIfPresent, indexedDbRoot, listIndexedDbOrigins, parseOrigin, statIfPresent };

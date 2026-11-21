'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { AppError } = require('../../contracts/ipc-result');
const { databasePaths, directoryIfPresent, indexedDbRoot, listIndexedDbOrigins, parseOrigin, statIfPresent } = require('./site-indexed-db-layout');
const { newDatabaseStaging, recordBatchMoves, commitBatch, recoverIndexedDbTransfer, finalizeDatabaseStaging } = require('./site-indexed-db-staging');

async function presentPaths(root, names) {
  if (!root) return [];
  const found = [];
  for (const name of names) {
    if (await directoryIfPresent(path.join(root, name))) found.push(name);
  }
  return found;
}

async function describeTree(root, name, entries) {
  const file = path.join(root, name);
  const stat = await fs.lstat(file);
  if (stat.isDirectory()) {
    for (const child of (await fs.readdir(file)).sort()) await describeTree(root, path.join(name, child), entries);
  } else if (stat.isFile()) {
    entries.push([name, stat.size, stat.mtimeMs]);
  } else {
    throw new AppError('SITE_DATABASE_PATH_INVALID', '网站数据库中存在不支持的链接或文件');
  }
}

async function describePaths(root, names) {
  const entries = [];
  for (const name of names) await describeTree(root, name, entries);
  return entries;
}

async function inspectOrigin(source, target, url) {
  const names = databasePaths(url);
  const files = await presentPaths(source, [names.sqlite, names.levelDb]);
  if (!files.includes(names.sqlite) && !files.includes(names.levelDb)) {
    throw new AppError('SITE_DATABASE_MISSING', '来源浏览器没有该来源地址的 IndexedDB');
  }
  if (files.includes(names.sqlite) && files.includes(names.levelDb)) {
    throw new AppError('SITE_DATABASE_FORMAT', '该网站包含两种数据库格式，请先在来源浏览器中打开一次该网站');
  }
  if (await hasTargetData(target, names)) {
    throw new AppError('SITE_DATABASE_CONFLICT', '目标浏览器已有该来源地址的数据库，已保留原有数据');
  }
  if (files.includes(names.levelDb) && await directoryIfPresent(path.join(source, names.blobs))) files.unshift(names.blobs);
  const entries = await describePaths(source, files);
  if (!entries.length) throw new AppError('SITE_DATABASE_MISSING', '来源浏览器的数据库为空');
  return { source, origin: url.origin, files, entries };
}

async function hasTargetData(root, names) {
  if (!root) return false;
  for (const name of Object.values(names)) {
    if (await statIfPresent(path.join(root, name))) return true;
  }
  return false;
}

async function inspectTransfer(sourceData, targetData, scope) {
  const origins = scope.host
    ? (await listIndexedDbOrigins(sourceData)).filter(origin => new URL(origin).hostname === scope.host)
    : [scope.origin];
  if (!origins.length) throw new AppError('SITE_DATABASE_MISSING', '来源浏览器没有该网站的 IndexedDB');
  const source = await indexedDbRoot(sourceData);
  const target = await indexedDbRoot(targetData);
  const plans = [];
  for (const origin of origins) plans.push(await inspectOrigin(source, target, parseOrigin(origin)));
  const revision = createHash('sha256').update(JSON.stringify([
    sourceData, targetData, scope, plans.map(plan => [plan.origin, plan.entries]),
  ])).digest('hex');
  return { plans, revision };
}

function report(scope, { plans, revision }) {
  const bytes = plans.reduce((sum, { entries }) => sum + entries.reduce((size, entry) => size + Number(entry[1]), 0), 0);
  return scope.host
    ? { host: scope.host, origins: plans.map(plan => plan.origin), revision, bytes }
    : { origin: scope.origin, revision, bytes };
}

async function stageDatabase(plan, staging) {
  for (const file of plan.files) {
    await fs.cp(path.join(plan.source, file), path.join(staging, file), {
      recursive: true, force: false, errorOnExist: true, filter: async (entry) => {
        const stat = await fs.lstat(entry);
        return stat.isDirectory() || stat.isFile();
      },
    });
  }
  // The staged copy must contain the same complete file set and byte lengths.
  const sizes = (entries) => entries.map(([name, size]) => [name, size]);
  if (JSON.stringify(sizes(await describePaths(staging, plan.files))) !== JSON.stringify(sizes(plan.entries))) {
    throw new AppError('SITE_DATABASE_VERIFY_FAILED', '复制后的数据库与预览不一致');
  }
}

async function publishDatabases(plans, staging, target) {
  await recordBatchMoves(staging, plans);
  for (const { files } of plans) {
    for (const name of files) {
      const destination = path.join(target, name);
      if (await statIfPresent(destination)) throw new AppError('SITE_DATABASE_CONFLICT', '目标浏览器已有该来源地址的数据库');
      await fs.rename(path.join(staging, name), destination);
    }
  }
  await commitBatch(staging);
}

async function transferIndexedDb(sourceData, targetData, scope, revision) {
  await recoverIndexedDbTransfer(targetData);
  const batch = await inspectTransfer(sourceData, targetData, scope);
  if (!revision) return report(scope, batch);
  if (revision !== batch.revision) throw new AppError('SITE_PREVIEW_STALE', '来源数据库已变化，请重新预览');
  const target = await indexedDbRoot(targetData, true);
  if (!target) throw new AppError('SITE_DATABASE_TARGET_MISSING', '请先打开目标浏览器一次，再关闭后复制');
  const staging = await newDatabaseStaging(target);
  try {
    for (const plan of batch.plans) await stageDatabase(plan, staging);
    const current = await inspectTransfer(sourceData, targetData, scope);
    if (current.revision !== revision) throw new AppError('SITE_PREVIEW_STALE', '来源数据库已变化，请重新预览');
    await publishDatabases(batch.plans, staging, target);
  } finally { await finalizeDatabaseStaging(target, staging); }
  return report(scope, batch);
}

module.exports = { transferIndexedDb };

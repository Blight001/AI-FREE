'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { databasePaths, indexedDbRoot, parseOrigin, statIfPresent } = require('./site-indexed-db-layout');

const stagingPrefix = '.ai-free-site-db-';
const journalName = 'pending-blobs.json';
const batchJournal = 'pending-batch.json';
const committedMarker = 'committed';

function newDatabaseStaging(target) { return fs.mkdtemp(path.join(target, `${stagingPrefix}${process.pid}-`)); }

function removeDatabaseStaging(dir) { return fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }

async function directoryIdentity(directory) {
  try {
    const stat = await fs.lstat(directory, { bigint: true });
    return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function recordBlobMove(staging, origin, blobName) {
  const identity = await directoryIdentity(path.join(staging, blobName));
  await fs.writeFile(path.join(staging, journalName), JSON.stringify({ origin, identity }), {
    flag: 'wx', encoding: 'utf8', flush: true,
  });
}

function stagingOwnerHasExited(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (error) { return error?.code === 'ESRCH'; }
}

async function readPendingBlobPaths(staging) {
  const journal = path.join(staging, journalName);
  const stat = await statIfPresent(journal);
  if (!stat?.isFile() || stat.size > 1024) return null;
  try {
    const record = JSON.parse(await fs.readFile(journal, 'utf8'));
    if (typeof record?.identity !== 'string' || !/^\d+:\d+$/.test(record.identity)) return null;
    return { ...databasePaths(parseOrigin(record.origin)), identity: record.identity };
  }
  catch (error) {
    if (error instanceof SyntaxError || error?.code === 'SITE_ORIGIN_INVALID') return null;
    throw error;
  }
}

async function recordBatchMoves(staging, plans) {
  const entries = [];
  for (const { origin, files } of plans) {
    for (const name of files) {
      entries.push({ origin, name, identity: await directoryIdentity(path.join(staging, name)) });
    }
  }
  await fs.writeFile(path.join(staging, batchJournal), JSON.stringify(entries), { flag: 'wx', flush: true });
}

async function commitBatch(staging) {
  await fs.writeFile(path.join(staging, committedMarker), '', { flag: 'wx', flush: true });
}

async function readBatchMoves(staging) {
  const journal = path.join(staging, batchJournal);
  if (!(await statIfPresent(journal))?.isFile()) return [];
  try {
    const entries = JSON.parse(await fs.readFile(journal, 'utf8'));
    return Array.isArray(entries) ? entries : [];
  } catch (error) {
    if (error instanceof SyntaxError) return []; // The journal is written before publishing any directories.
    throw error;
  }
}

function validBatchEntry(entry) {
  if (typeof entry?.identity !== 'string' || !/^\d+:\d+$/.test(entry.identity)) return false;
  try { return Object.values(databasePaths(parseOrigin(entry.origin))).includes(entry.name); }
  catch { return false; }
}

async function rollBackBatch(root, staging) {
  if ((await statIfPresent(path.join(staging, committedMarker)))?.isFile()) {
    // Remove the journal first so interrupted cleanup cannot roll back a committed copy.
    await fs.rm(path.join(staging, batchJournal), { force: true });
    return;
  }
  for (const entry of (await readBatchMoves(staging)).reverse()) {
    if (!validBatchEntry(entry) || await statIfPresent(path.join(staging, entry.name))) continue;
    const moved = path.join(root, entry.name);
    if (await directoryIdentity(moved) === entry.identity) await removeDatabaseStaging(moved);
  }
}

async function finalizeDatabaseStaging(root, staging) {
  await rollBackBatch(root, staging);
  const pending = await readPendingBlobPaths(staging);
  if (pending && !await statIfPresent(path.join(staging, pending.blobs))) {
    const paths = [pending.levelDb, pending.sqlite].map(file => path.join(root, file));
    const databases = await Promise.all(paths.map(statIfPresent));
    const blobs = path.join(root, pending.blobs);
    if (databases.every(stat => !stat) && await directoryIdentity(blobs) === pending.identity) await removeDatabaseStaging(blobs);
  }
  await removeDatabaseStaging(staging);
}

// The caller holds the target Profile lock before checking for interrupted copies.
async function recoverIndexedDbTransfer(chromiumData) {
  const root = await indexedDbRoot(chromiumData);
  if (!root) return;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(stagingPrefix)) continue;
    const owner = /^(\d+)-[a-z\d]{6}$/i.exec(entry.name.slice(stagingPrefix.length));
    if (!owner) continue;
    const pid = Number(owner[1]);
    if (pid === process.pid || stagingOwnerHasExited(pid)) await finalizeDatabaseStaging(root, path.join(root, entry.name));
  }
}

module.exports = { newDatabaseStaging, recordBlobMove, recordBatchMoves, commitBatch, recoverIndexedDbTransfer, finalizeDatabaseStaging };

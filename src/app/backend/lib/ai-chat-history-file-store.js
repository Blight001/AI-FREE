'use strict';

const crypto = require('crypto');
const fsDefault = require('fs');
const pathDefault = require('path');
const { app } = require('electron');
const { resolveUserDataDir } = require('../config/user-data-path');
const { AppError } = require('../../contracts/ipc-result');

const INDEX_VERSION = 2;
const TEMP_FILE_PATTERN = /^ai-history-tmp-(\d+)-[a-f0-9-]+\.tmp$/;
const SESSION_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;

function emptyIndex() {
  return { version: INDEX_VERSION, currentId: '', sessions: [] };
}

function storageKey(id) {
  return crypto.createHash('sha256').update(String(id)).digest('hex');
}

function safeScope(scope) {
  const value = String(scope || 'anonymous');
  return /^[a-zA-Z0-9_-]{1,128}$/.test(value)
    ? value
    : crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function cleanupOwnedTemps(fs, path, directory) {
  let entries = [];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = TEMP_FILE_PATTERN.exec(entry.name);
    if (match && !processIsAlive(Number(match[1]))) {
      try { fs.unlinkSync(path.join(directory, entry.name)); } catch (_) {}
    }
  }
}

function createJsonFileIO(fs, path) {
  function atomicWriteJson(file, value) {
    const directory = path.dirname(file);
    const temporary = path.join(directory, `ai-history-tmp-${process.pid}-${crypto.randomUUID()}.tmp`);
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temporary, file);
      return true;
    } catch (_) {
      return false;
    } finally {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (_) {}
    }
  }

  function readJson(file, code, message) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {
      throw new AppError(code, message, { retryable: false });
    }
  }
  return { atomicWriteJson, readJson };
}

function createScopePathResolver(rootDir, path) {
  return (scope) => {
    const name = safeScope(scope);
    const directory = path.join(rootDir, name);
    return {
      directory,
      scope: name,
      sessionsDir: path.join(directory, 'sessions'),
      indexFile: path.join(directory, 'index.json'),
      migrationFile: path.join(directory, 'migration.json'),
      legacyFile: path.join(rootDir, `${name}.json`),
    };
  };
}

function createSessionFileAccess({ fs, path, scopePaths, atomicWriteJson, readJson }) {
  function sessionFile(paths, id) {
    return path.join(paths.sessionsDir, `${storageKey(id)}.json`);
  }
  function indexEntry(paths, summary) {
    const stat = fs.statSync(sessionFile(paths, summary.id));
    return { ...summary, storageKey: storageKey(summary.id), fileSize: stat.size, fileMtimeMs: stat.mtimeMs };
  }
  function writeIndex(paths, index) {
    return atomicWriteJson(paths.indexFile, {
      version: INDEX_VERSION,
      currentId: String(index.currentId || ''),
      sessions: Array.isArray(index.sessions) ? index.sessions : [],
    });
  }
  function writeSession(scope, session) {
    return atomicWriteJson(sessionFile(scopePaths(scope), session.id), session);
  }
  function readSession(scope, id) {
    const file = sessionFile(scopePaths(scope), id);
    if (!fs.existsSync(file)) return null;
    const session = readJson(file, 'AI_HISTORY_SESSION_CORRUPT', '本地对话内容无法读取；原始文件已保留');
    return session && typeof session === 'object' && String(session.id || '') === String(id) ? session : null;
  }
  function deleteSession(scope, id) {
    try { fs.unlinkSync(sessionFile(scopePaths(scope), id)); return true; }
    catch (error) { return error?.code === 'ENOENT'; }
  }
  return { deleteSession, indexEntry, readSession, writeIndex, writeSession };
}

function createLegacyMigrator({ fs, io, files, normalizeSession, summarizeSession }) {
  const { atomicWriteJson, readJson } = io;
  const { indexEntry, readSession, writeIndex, writeSession } = files;

  function readLegacyStore(file) {
    const legacy = readJson(file, 'AI_HISTORY_MIGRATION_READ_FAILED', '旧版对话历史无法读取；原始文件已保留');
    if (!legacy || typeof legacy !== 'object') {
      throw new AppError('AI_HISTORY_MIGRATION_INVALID', '旧版对话历史格式无效；原始文件已保留');
    }
    return { currentId: String(legacy.currentId || ''), sessions: Array.isArray(legacy.sessions) ? legacy.sessions : [] };
  }
  function stableLegacyId(session, index, usedIds) {
    const rawId = String(session?.id || '').trim();
    if (rawId && !usedIds.has(rawId)) return rawId;
    const seed = `${index}:${rawId}:${JSON.stringify(session || {})}`;
    return `legacy-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
  }
  function migrateLegacy(paths) {
    if (!fs.existsSync(paths.legacyFile)) return emptyIndex();
    if (!atomicWriteJson(paths.migrationFile, { version: INDEX_VERSION, state: 'in-progress' })) {
      throw new AppError('AI_HISTORY_MIGRATION_MARKER_FAILED', '无法初始化历史迁移；旧版历史已保留', { retryable: true });
    }
    const legacy = readLegacyStore(paths.legacyFile);
    const usedIds = new Set();
    const sessions = [];
    for (let index = 0; index < legacy.sessions.length; index += 1) {
      const raw = legacy.sessions[index];
      const id = stableLegacyId(raw, index, usedIds);
      const session = normalizeSession({ ...(raw || {}), id });
      if (usedIds.has(session.id)) {
        throw new AppError('AI_HISTORY_MIGRATION_DUPLICATE_ID', '旧版对话存在重复标识，原始历史已保留');
      }
      usedIds.add(session.id);
      if (!writeSession(paths.scope, session)) {
        throw new AppError('AI_HISTORY_MIGRATION_WRITE_FAILED', '迁移对话内容失败；旧版历史已保留', { retryable: true });
      }
      const saved = readSession(paths.scope, session.id);
      if (!saved || JSON.stringify(saved) !== JSON.stringify(session)) {
        throw new AppError('AI_HISTORY_MIGRATION_VERIFY_FAILED', '迁移校验失败；旧版历史已保留', { retryable: true });
      }
      sessions.push(indexEntry(paths, summarizeSession(session)));
    }
    const currentId = sessions.some((session) => session.id === legacy.currentId) ? legacy.currentId : '';
    const index = { version: INDEX_VERSION, currentId, sessions };
    if (!writeIndex(paths, index)) {
      throw new AppError('AI_HISTORY_MIGRATION_INDEX_FAILED', '保存对话索引失败；旧版历史已保留', { retryable: true });
    }
    if (!atomicWriteJson(paths.migrationFile, { version: INDEX_VERSION, state: 'complete' })) {
      throw new AppError('AI_HISTORY_MIGRATION_MARKER_FAILED', '历史已转换但迁移标记未完成；旧版历史已保留', { retryable: true });
    }
    return index;
  }
  return { migrateLegacy };
}

function createIndexRebuilder({ fs, path, io, files, normalizeSession, summarizeSession }) {
  const { readJson } = io;
  const { indexEntry, writeIndex } = files;
  function validIndex(index) {
    if (index?.version !== INDEX_VERSION || !Array.isArray(index.sessions)) return false;
    const ids = index.sessions.map((item) => String(item?.id || ''));
    return ids.every(Boolean) && new Set(ids).size === ids.length;
  }
  function summarizeFile(paths, file, expectedId = '') {
    const raw = readJson(file, 'AI_HISTORY_SESSION_CORRUPT', '本地对话内容无法读取；原始文件已保留');
    const id = String(raw?.id || '');
    if (!raw || typeof raw !== 'object' || !id || storageKey(id) !== path.basename(file, '.json')
      || (expectedId && id !== expectedId)) {
      throw new AppError('AI_HISTORY_SESSION_CORRUPT', '本地对话索引与内容不匹配；原始文件已保留');
    }
    return indexEntry(paths, summarizeSession(normalizeSession(raw)));
  }
  function sessionFiles(paths) {
    return fs.readdirSync(paths.sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && SESSION_FILE_PATTERN.test(entry.name));
  }
  function rebuildIndex(paths, currentId = '') {
    const sessions = sessionFiles(paths).map((entry) => summarizeFile(paths, path.join(paths.sessionsDir, entry.name)));
    const ids = new Set(sessions.map((session) => session.id));
    const index = { version: INDEX_VERSION, currentId: ids.has(currentId) ? currentId : '', sessions };
    if (!writeIndex(paths, index)) {
      throw new AppError('AI_HISTORY_INDEX_REBUILD_FAILED', '无法修复对话索引；原始对话内容已保留', { retryable: true });
    }
    return index;
  }
  function reconcileIndex(paths, index) {
    const actual = new Map(sessionFiles(paths).map((entry) => [
      entry.name.slice(0, -5), path.join(paths.sessionsDir, entry.name),
    ]));
    const known = new Set();
    let changed = false;
    const sessions = [];
    for (const entry of index.sessions) {
      const key = storageKey(entry.id);
      const file = actual.get(key);
      if (!file) { changed = true; continue; }
      known.add(key);
      const stat = fs.statSync(file);
      if (entry.storageKey === key && entry.fileSize === stat.size && entry.fileMtimeMs === stat.mtimeMs) {
        sessions.push(entry);
      } else {
        sessions.push(summarizeFile(paths, file, String(entry.id)));
        changed = true;
      }
    }
    for (const [key, file] of actual) {
      if (known.has(key)) continue;
      sessions.push(summarizeFile(paths, file));
      changed = true;
    }
    const ids = new Set(sessions.map((session) => session.id));
    const currentId = ids.has(index.currentId) ? index.currentId : '';
    if (currentId !== index.currentId) changed = true;
    const repaired = { version: INDEX_VERSION, currentId, sessions };
    if (changed && !writeIndex(paths, repaired)) {
      throw new AppError('AI_HISTORY_INDEX_REPAIR_FAILED', '无法修复对话索引；原始对话内容已保留', { retryable: true });
    }
    return repaired;
  }
  return { rebuildIndex, reconcileIndex, validIndex };
}

function createIndexRecovery({ fs, path, io, files, scopePaths, normalizeSession, summarizeSession, migrateLegacy }) {
  const { readJson } = io;
  const { rebuildIndex, reconcileIndex, validIndex } = createIndexRebuilder({
    fs, path, io, files, normalizeSession, summarizeSession,
  });
  function migrationState(paths) {
    try { return readJson(paths.migrationFile, 'AI_HISTORY_MIGRATION_MARKER_INVALID', '历史迁移状态无法读取'); }
    catch (_) { return null; }
  }
  function missingIndex(paths, marker) {
    if (marker?.state === 'complete') return rebuildIndex(paths);
    if (fs.existsSync(paths.legacyFile)) return migrateLegacy(paths);
    return rebuildIndex(paths);
  }
  function recoverIndex(paths, marker) {
    let index;
    try { index = readJson(paths.indexFile, 'AI_HISTORY_INDEX_CORRUPT', '本地对话索引损坏；正在从会话文件恢复'); }
    catch (_) {
      if (marker?.state === 'in-progress' && fs.existsSync(paths.legacyFile)) return migrateLegacy(paths);
      return rebuildIndex(paths);
    }
    if (!validIndex(index)) {
      if (marker?.state === 'in-progress' && fs.existsSync(paths.legacyFile)) return migrateLegacy(paths);
      return rebuildIndex(paths, String(index?.currentId || ''));
    }
    const repaired = reconcileIndex(paths, index);
    if (fs.existsSync(paths.legacyFile) && marker?.state !== 'complete' && !writeMigrationComplete(paths)) {
      throw new AppError('AI_HISTORY_MIGRATION_MARKER_FAILED', '历史已转换但迁移标记未完成；旧版历史已保留', { retryable: true });
    }
    return repaired;
  }
  function writeMigrationComplete(paths) {
    return io.atomicWriteJson(paths.migrationFile, { version: INDEX_VERSION, state: 'complete' });
  }
  function readIndex(scope) {
    const paths = scopePaths(scope);
    fs.mkdirSync(paths.sessionsDir, { recursive: true });
    cleanupOwnedTemps(fs, path, paths.directory);
    cleanupOwnedTemps(fs, path, paths.sessionsDir);
    const marker = migrationState(paths);
    return fs.existsSync(paths.indexFile) ? recoverIndex(paths, marker) : missingIndex(paths, marker);
  }
  return { readIndex };
}

function createAiChatHistoryFileStore(options = {}) {
  const fs = options.fs || fsDefault;
  const path = options.path || pathDefault;
  const rootDir = options.historyRootDir
    || path.join(resolveUserDataDir(options.app || app), 'ai-chat-history');
  const scopePaths = createScopePathResolver(rootDir, path);
  const io = createJsonFileIO(fs, path);
  const normalizeSession = options.normalizeSession || ((session) => session);
  const summarizeSession = options.summarizeSession || ((session) => session);
  const files = createSessionFileAccess({ fs, path, scopePaths, ...io });
  const { migrateLegacy } = createLegacyMigrator({ fs, io, files, normalizeSession, summarizeSession });
  const recovery = createIndexRecovery({
    fs, path, io, files, scopePaths, normalizeSession, summarizeSession, migrateLegacy,
  });
  return {
    ...files,
    ...recovery,
    writeIndex: (scope, index) => files.writeIndex(scopePaths(scope), index),
    indexEntry: (scope, summary) => files.indexEntry(scopePaths(scope), summary),
  };
}

module.exports = { createAiChatHistoryFileStore };


'use strict';

const fs = require('fs');
const path = require('path');
const { callOptional, firstText } = require('../../shared/safe-values');

const SESSION_FILE_PATTERN = /^(Session|Tabs)_(\d+)$/;
const text = (...values) => firstText(...values).trim();

function getChromiumSessionsDir(paths = {}) {
  return path.join(String(paths.chromiumData || ''), 'Default', 'Sessions');
}

function sessionFileTimestamp(name) {
  const match = SESSION_FILE_PATTERN.exec(String(name || ''));
  try { return match ? BigInt(match[2]) : 0n; } catch (_) { return 0n; }
}

function containsRestorableWebUrl(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false;
  return buffer.includes(Buffer.from('https://', 'ascii'))
    || buffer.includes(Buffer.from('http://', 'ascii'))
    || buffer.includes(Buffer.from('https://', 'utf16le'))
    || buffer.includes(Buffer.from('http://', 'utf16le'));
}

// Chromium 150 的 Session 文件由 SNSS 头和一串 SessionCommand 组成：
// uint16 commandSize + uint8 commandId + payload。只搜索 URL 会把已经追加
// TabClosed(16) 的旧导航误判成可恢复页面，因此这里按 Chromium 的命令顺序
// 还原“当前仍属于窗口的标签”集合。
function applyChromiumSessionCommand(state, commandId, buffer, offset, payloadSize) {
  if (commandId === 9 && payloadSize >= 4) {
    state.windows.add(buffer.readInt32LE(offset));
    return;
  }
  if (commandId === 0 && payloadSize >= 8) {
    state.tabs.set(buffer.readInt32LE(offset + 4), buffer.readInt32LE(offset));
    return;
  }
  if (commandId === 16 && payloadSize >= 4) {
    state.tabs.delete(buffer.readInt32LE(offset));
    return;
  }
  if (commandId !== 17 || payloadSize < 4) return;
  const windowId = buffer.readInt32LE(offset);
  state.windows.delete(windowId);
  for (const [tabId, tabWindowId] of state.tabs) {
    if (tabWindowId === windowId) state.tabs.delete(tabId);
  }
}

function analyzeChromiumSession(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || buffer.subarray(0, 4).toString('ascii') !== 'SNSS') {
    return { valid: false, liveTabCount: 0, hasWebUrl: false };
  }
  const state = { windows: new Set(), tabs: new Map() };
  let offset = 8;
  let valid = true;
  while (offset + 3 <= buffer.length) {
    const commandSize = buffer.readUInt16LE(offset);
    const commandEnd = offset + 2 + commandSize;
    if (commandSize < 1 || commandEnd > buffer.length) {
      valid = false;
      break;
    }
    const commandId = buffer[offset + 2];
    const payloadOffset = offset + 3;
    const payloadSize = commandSize - 1;
    applyChromiumSessionCommand(state, commandId, buffer, payloadOffset, payloadSize);
    offset = commandEnd;
  }
  const liveTabCount = Array.from(state.tabs.values())
    .filter((windowId) => state.windows.has(windowId)).length;
  return {
    valid,
    liveTabCount,
    hasWebUrl: containsRestorableWebUrl(buffer),
  };
}

function hasRestorableSessionBuffer(buffer) {
  const analysis = analyzeChromiumSession(buffer);
  return analysis.valid && analysis.liveTabCount > 0 && analysis.hasWebUrl;
}

function snapshotHasRestorableSession(snapshot) {
  return Boolean(snapshot?.files?.some((file) => (
    String(file?.name || '').startsWith('Session_')
    && hasRestorableSessionBuffer(file.data)
  )));
}

function getStableSessionDir(paths = {}) {
  return path.join(String(paths.root || path.dirname(paths.chromiumData || '')), 'session-recovery-stable');
}

function persistStableChromiumSession(paths = {}, snapshot, logger = console) {
  if (!snapshotHasRestorableSession(snapshot)) return false;
  const stableDir = getStableSessionDir(paths);
  const temporaryDir = `${stableDir}.tmp`;
  try {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
    fs.mkdirSync(temporaryDir, { recursive: true });
    for (const file of snapshot.files) {
      if (SESSION_FILE_PATTERN.test(String(file?.name || '')) && Buffer.isBuffer(file.data)) {
        fs.writeFileSync(path.join(temporaryDir, file.name), file.data);
      }
    }
    fs.rmSync(stableDir, { recursive: true, force: true });
    fs.renameSync(temporaryDir, stableDir);
    return true;
  } catch (error) {
    logger?.warn?.('[ChromiumRuntime] 保存稳定 Session 备份失败:', error?.message || error);
    try { fs.rmSync(temporaryDir, { recursive: true, force: true }); } catch (_) {}
    return false;
  }
}

function loadStableChromiumSession(paths = {}, logger = console) {
  const stableDir = getStableSessionDir(paths);
  try {
    const files = fs.readdirSync(stableDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && SESSION_FILE_PATTERN.test(entry.name))
      .map((entry) => ({ name: entry.name, data: fs.readFileSync(path.join(stableDir, entry.name)) }));
    const snapshot = { sessionsDir: getChromiumSessionsDir(paths), files };
    return snapshotHasRestorableSession(snapshot) ? snapshot : null;
  } catch (error) {
    if (error?.code !== 'ENOENT') logger?.warn?.('[ChromiumRuntime] 读取稳定 Session 备份失败:', error?.message || error);
    return null;
  }
}

// 旧版 close-browser 会先关闭最后一个窗口，再正常退出 Chromium，导致最新
// Session 被写成 0 窗口。若上一组 Session 仍包含网页，则隔离空白的最新组，
// 让 Chromium 自动回退读取上一组有效会话。
function readChromiumSessionEntries(sessionsDir) {
  try {
    return fs.readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && SESSION_FILE_PATTERN.test(entry.name))
      .map((entry) => ({
        name: entry.name,
        path: path.join(sessionsDir, entry.name),
        type: entry.name.startsWith('Session_') ? 'Session' : 'Tabs',
        timestamp: sessionFileTimestamp(entry.name),
      }));
  } catch (_) {
    return [];
  }
}

function entryHasRestorableSession(entry) {
  try {
    return hasRestorableSessionBuffer(fs.readFileSync(entry.path));
  } catch (_) {
    return false;
  }
}

function sessionTimestampDistance(entry, target) {
  return entry.timestamp > target.timestamp
    ? entry.timestamp - target.timestamp
    : target.timestamp - entry.timestamp;
}

function discardBlankSessionFiles(paths, sessionsDir, entries, logger) {
  const recoveryRoot = text(paths.root, path.dirname(paths.chromiumData || sessionsDir));
  const recoveryDir = path.join(recoveryRoot, 'session-recovery-discarded');
  const removed = [];
  try {
    fs.mkdirSync(recoveryDir, { recursive: true });
    for (const entry of entries.filter(Boolean)) {
      fs.renameSync(entry.path, path.join(recoveryDir, `${Date.now()}-${entry.name}`));
      removed.push(entry.name);
    }
    callOptional(logger, 'warn', '[ChromiumRuntime] 已隔离空白的最新 Session，回退到上一组有效网页会话:', removed);
    return { repaired: true, removed };
  } catch (error) {
    callOptional(logger, 'warn', '[ChromiumRuntime] 修复空白 Session 失败:', text(error && error.message, error));
    return { repaired: false, removed };
  }
}

function repairBlankLatestSession(paths = {}, logger = console) {
  const sessionsDir = getChromiumSessionsDir(paths);
  const entries = readChromiumSessionEntries(sessionsDir);
  const sessionEntries = entries.filter((entry) => entry.type === 'Session')
    .sort((left, right) => left.timestamp > right.timestamp ? -1 : 1);
  if (sessionEntries.length < 2) return { repaired: false, removed: [] };
  if (entryHasRestorableSession(sessionEntries[0])) return { repaired: false, removed: [] };
  const previousValid = sessionEntries.slice(1).find(entryHasRestorableSession);
  if (!previousValid) return { repaired: false, removed: [] };
  const latestSession = sessionEntries[0];
  const closestTabs = entries.filter((entry) => entry.type === 'Tabs')
    .sort((left, right) => sessionTimestampDistance(left, latestSession) < sessionTimestampDistance(right, latestSession) ? -1 : 1)[0];
  return discardBlankSessionFiles(paths, sessionsDir, [latestSession, closestTabs], logger);
}

function captureChromiumSessionFiles(paths = {}, logger = console) {
  const sessionsDir = getChromiumSessionsDir(paths);
  try {
    const files = fs.readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && SESSION_FILE_PATTERN.test(entry.name))
      .map((entry) => ({
        name: entry.name,
        data: fs.readFileSync(path.join(sessionsDir, entry.name)),
      }));
    return files.length ? { sessionsDir, files } : null;
  } catch (error) {
    if (error?.code !== 'ENOENT') logger?.warn?.('[ChromiumRuntime] 捕获 Session 快照失败:', error?.message || error);
    return null;
  }
}

function prepareChromiumSessionRecovery(paths = {}, logger = console) {
  repairBlankLatestSession(paths, logger);
  let snapshot = captureChromiumSessionFiles(paths, logger);
  if (snapshotHasRestorableSession(snapshot)) {
    persistStableChromiumSession(paths, snapshot, logger);
    return { restorable: true, source: 'profile' };
  }
  snapshot = loadStableChromiumSession(paths, logger);
  if (snapshot && restoreChromiumSessionFiles(snapshot, logger)) {
    logger?.warn?.('[ChromiumRuntime] 当前 Session 无活动标签，已恢复启动前的稳定备份');
    return { restorable: true, source: 'stable-backup' };
  }
  return { restorable: false, source: 'none' };
}

function restoreChromiumSessionFiles(snapshot, logger = console) {
  if (!snapshot?.sessionsDir || !Array.isArray(snapshot.files) || snapshot.files.length === 0) return false;
  try {
    fs.mkdirSync(snapshot.sessionsDir, { recursive: true });
    for (const entry of fs.readdirSync(snapshot.sessionsDir, { withFileTypes: true })) {
      if (entry.isFile() && SESSION_FILE_PATTERN.test(entry.name)) {
        fs.rmSync(path.join(snapshot.sessionsDir, entry.name), { force: true });
      }
    }
    for (const file of snapshot.files) {
      const target = path.join(snapshot.sessionsDir, file.name);
      const temporary = `${target}.ai-free-tmp`;
      fs.writeFileSync(temporary, file.data);
      fs.renameSync(temporary, target);
    }
    return true;
  } catch (error) {
    logger?.warn?.('[ChromiumRuntime] 恢复退出前 Session 快照失败:', error?.message || error);
    return false;
  }
}

module.exports = {
  captureChromiumSessionFiles,
  loadStableChromiumSession,
  persistStableChromiumSession,
  prepareChromiumSessionRecovery,
  repairBlankLatestSession,
  restoreChromiumSessionFiles,
  snapshotHasRestorableSession,
};

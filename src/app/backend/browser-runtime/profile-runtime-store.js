const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function normalizeProfileId(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized === '.' || normalized === '..') {
    throw new Error('无效的 Profile ID');
  }
  return normalized;
}

// 旧版本只做字符替换，不同业务 ID 可能得到同一个目录名。仅用于迁移。
function legacySafeProfileId(value) {
  return normalizeProfileId(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function safeProfileId(value) {
  const raw = normalizeProfileId(value);
  const legacyId = legacySafeProfileId(raw);
  if (raw === legacyId && raw.length <= 96) return raw;
  const readablePrefix = legacyId.replace(/^_+|_+$/g, '').slice(0, 72) || 'profile';
  const digest = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
  return `${readablePrefix}--${digest}`;
}

function openProfileLockFile(paths) {
  try { return fs.openSync(paths.lock, 'wx'); } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const lock = JSON.parse(fs.readFileSync(paths.lock, 'utf8'));
  const pid = Number(lock.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Profile ${paths.id} 的锁无效`);
  try {
    process.kill(pid, 0);
    throw new Error(`Profile ${paths.id} 已被进程 ${pid} 使用`);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  fs.unlinkSync(paths.lock);
  return fs.openSync(paths.lock, 'wx');
}

function assertProfileLockInactive(target) {
  const lockPath = path.join(target, '.runtime.lock');
  if (!fs.existsSync(lockPath)) return;
  const pid = Number(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Profile 锁无效，无法安全删除');
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return;
    throw error;
  }
  throw new Error(`Profile ${path.basename(target)} 仍被进程 ${pid} 使用，不能删除`);
}

class ProfileRuntimeStore {
  constructor(options = {}) {
    this.rootDir = path.resolve(String(options.rootDir || 'chromium-profiles'));
    this.downloadsDir = options.downloadsDir ? path.resolve(String(options.downloadsDir)) : '';
    this.logger = options.logger || console;
    this.locks = new Map();
    this.deletingRoots = new Set();
  }

  getPathsForStorageId(storageId) {
    const id = String(storageId || '').trim();
    if (!id || id === '.' || id === '..') throw new Error('无效的 Profile 存储 ID');
    const root = path.join(this.rootDir, id);
    return {
      id,
      root,
      config: path.join(root, 'profile.json'),
      chromiumData: path.join(root, 'chromium-data'),
      extensions: path.join(root, 'extensions.json'),
      proxy: path.join(root, 'proxy.enc'),
      fingerprint: path.join(root, 'fingerprint.json'),
      downloads: this.downloadsDir || path.join(root, 'downloads'),
      crashpad: path.join(root, 'crashpad'),
      logs: path.join(root, 'logs'),
      lock: path.join(root, '.runtime.lock'),
    };
  }

  getProfilePaths(profileId) {
    return this.getPathsForStorageId(safeProfileId(profileId));
  }

  getLegacyProfilePaths(profileId) {
    return this.getPathsForStorageId(legacySafeProfileId(profileId));
  }

  assertNotDeleting(profileId) {
    if (this.resolveDeletionRoots(profileId).some((root) => this.deletingRoots.has(root))) {
      throw new Error('Chromium Profile 正在删除，请稍后重试');
    }
  }

  migrateLegacyProfile(profileId) {
    this.assertNotDeleting(profileId);
    const paths = this.getProfilePaths(profileId);
    const legacyPaths = this.getLegacyProfilePaths(profileId);
    if (paths.root === legacyPaths.root || fs.existsSync(paths.root) || !fs.existsSync(legacyPaths.root)) {
      return paths;
    }

    if (fs.existsSync(legacyPaths.lock)) {
      let lock = {};
      try { lock = JSON.parse(fs.readFileSync(legacyPaths.lock, 'utf8')); } catch (_) {}
      const pid = Number(lock.pid || 0);
      if (pid > 0) {
        try {
          process.kill(pid, 0);
          throw new Error(`旧版 Profile ${legacyPaths.id} 仍被进程 ${pid} 使用，暂不能迁移`);
        } catch (error) {
          if (!error || error.code !== 'ESRCH') throw error;
        }
      }
      try { fs.unlinkSync(legacyPaths.lock); } catch (_) {}
    }

    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.renameSync(legacyPaths.root, paths.root);
    this.logger?.log?.(`[ChromiumProfile] 已迁移旧版目录: ${legacyPaths.id} -> ${paths.id}`);
    return paths;
  }

  ensureProfile(profile = {}) {
    const businessProfileId = normalizeProfileId(profile.profileId || profile.id);
    if (this.locks.get(safeProfileId(businessProfileId))?.offlineTransfer) {
      throw new Error('网站数据复制期间不能启动浏览器');
    }
    const paths = this.migrateLegacyProfile(businessProfileId);
    for (const dir of [paths.root, paths.chromiumData, paths.downloads, paths.crashpad, paths.logs]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const previous = this.readProfile(businessProfileId);
    const config = {
      profileId: businessProfileId,
      storageId: paths.id,
      runtimeType: 'chromium',
      createdAt: previous.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      displayName: String(profile.displayName || previous.displayName || '').trim(),
    };
    fs.writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return { ...paths, config: paths.config, profile: config };
  }

  readProfile(profileId) {
    const paths = this.getProfilePaths(profileId);
    const legacyPaths = this.getLegacyProfilePaths(profileId);
    const configPath = fs.existsSync(paths.config) ? paths.config : legacyPaths.config;
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (_) {
      return {};
    }
  }

  acquireLock(profileId, metadata = {}) {
    this.assertNotDeleting(profileId);
    const existing = metadata.offlineTransfer ? this.getProfilePaths(profileId) : this.migrateLegacyProfile(profileId);
    const lease = this.locks.get(existing.id);
    if (lease) {
      if (lease.offlineTransfer || metadata.offlineTransfer) throw new Error('Profile 正在使用');
      return lease;
    }
    if (metadata.offlineTransfer && !fs.existsSync(existing.config)) throw new Error('Profile 尚未初始化');
    const paths = fs.existsSync(existing.config) ? existing : this.ensureProfile({ profileId });
    const fd = openProfileLockFile(paths);
    const lockData = { pid: process.pid, acquiredAt: Date.now(), ...metadata };
    try { fs.writeFileSync(fd, JSON.stringify(lockData), 'utf8'); } catch (error) {
      try { fs.closeSync(fd); } finally { fs.unlinkSync(paths.lock); }
      throw error;
    }
    const lock = { fd, path: paths.lock, profileId: paths.id, offlineTransfer: metadata.offlineTransfer === true };
    this.locks.set(paths.id, lock);
    return lock;
  }

  releaseLock(profileId, lease = null) {
    const id = safeProfileId(profileId);
    const lock = this.locks.get(id);
    if (!lock || (lock.offlineTransfer && lock !== lease)) return false;
    try { fs.closeSync(lock.fd); } catch (_) {}
    try { fs.unlinkSync(lock.path); } catch (_) {}
    this.locks.delete(id);
    return true;
  }

  listProfiles() {
    let entries = [];
    try {
      entries = fs.readdirSync(this.rootDir, { withFileTypes: true });
    } catch (_) {
      return [];
    }
    return entries.filter((entry) => entry.isDirectory()).map((entry) => {
      const paths = this.getPathsForStorageId(entry.name);
      let config = {};
      let stat = null;
      try { config = JSON.parse(fs.readFileSync(paths.config, 'utf8')); } catch (_) {}
      try { stat = fs.statSync(paths.root); } catch (_) {}
      return {
        storageId: entry.name,
        profileId: String(config?.profileId || '').trim(),
        displayName: String(config?.displayName || '').trim(),
        createdAt: String(config?.createdAt || '').trim(),
        updatedAt: String(config?.updatedAt || '').trim(),
        lastModifiedAt: Number(stat?.mtimeMs || 0),
      };
    });
  }

  auditProfiles(referencedProfileIds = []) {
    const referencedStorageIds = new Set();
    for (const rawId of referencedProfileIds) {
      const profileId = String(rawId || '').trim();
      if (!profileId) continue;
      try {
        referencedStorageIds.add(safeProfileId(profileId));
        referencedStorageIds.add(legacySafeProfileId(profileId));
      } catch (_) {}
    }
    const profiles = this.listProfiles();
    const orphanProfiles = profiles.filter((profile) => !referencedStorageIds.has(profile.storageId));
    return {
      totalCount: profiles.length,
      referencedCount: profiles.length - orphanProfiles.length,
      orphanCount: orphanProfiles.length,
      orphanProfiles,
    };
  }

  clearBrowserData(profileId) {
    this.assertNotDeleting(profileId);
    const id = safeProfileId(profileId);
    if (this.locks.has(id)) throw new Error(`Profile ${id} 仍在运行，不能清空数据`);
    const paths = this.getProfilePaths(profileId);
    const targets = [
      paths.chromiumData,
      path.join(paths.root, 'session-recovery-stable'),
      path.join(paths.root, 'session-recovery-discarded'),
    ];
    for (const target of targets) {
      const relative = path.relative(paths.root, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Profile 数据清理路径越界');
      }
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    fs.mkdirSync(paths.chromiumData, { recursive: true });
    return true;
  }

  resolveDeletionRoots(profileId) {
    return [...new Set([this.getProfilePaths(profileId).root, this.getLegacyProfilePaths(profileId).root])];
  }

  validateDeletionRoots(profileId) {
    this.assertNotDeleting(profileId);
    const roots = this.resolveDeletionRoots(profileId);
    for (const target of roots) {
      const relative = path.relative(this.rootDir, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Profile 删除路径越界');
      if (this.locks.has(relative)) throw new Error(`Profile ${relative} 仍在运行，不能删除`);
      assertProfileLockInactive(target);
    }
    return roots;
  }

  deleteProfile(profileId) {
    for (const target of this.validateDeletionRoots(profileId)) {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    return true;
  }

  async deleteProfileAsync(profileId) {
    const targets = this.validateDeletionRoots(profileId);
    for (const target of targets) this.deletingRoots.add(target);
    try {
      for (const target of targets) {
        await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
      return true;
    } finally {
      for (const target of targets) this.deletingRoots.delete(target);
    }
  }
}

module.exports = { ProfileRuntimeStore, legacySafeProfileId, safeProfileId };

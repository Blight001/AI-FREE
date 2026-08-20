'use strict';

const fs = require('fs');
const { atomicWrite } = require('../../services/automation-card-store');

const PRODUCT_ID = 'ai-free-app';
const TARGET_ID = 'windows-x86_64-stable';
const MAX_NOTICES = 20;

function readNoticeKeys(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(value.notices) ? value.notices.map(String) : [];
  } catch (_) {
    return [];
  }
}

function validatedReleasePage(server, value) {
  const base = new URL(server);
  const target = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(target.protocol) || target.origin !== base.origin) {
    throw new Error('更新页必须属于当前 HeySure 服务器');
  }
  return target.toString();
}

class DeviceHallUpdateChecker {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch;
    this.filePath = options.filePath;
    this.version = String(options.version || '0.0.0');
    this.confirmDownload = options.confirmDownload || (async () => false);
    this.openExternal = options.openExternal || (async () => {});
    this.logger = options.logger || console;
    this.inFlight = null;
  }

  check(server) {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.checkOnce(server)
      .catch((error) => this.logger.warn?.('[DeviceHallUpdate] 检查更新失败（不影响连接）:', error?.message || error))
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async checkOnce(server) {
    const base = new URL(String(server || '')).toString().replace(/\/$/, '');
    const endpoint = `${base}/api/device-hall/updates/${PRODUCT_ID}/${TARGET_ID}?current_version=${encodeURIComponent(this.version)}`;
    const response = await this.fetch(endpoint, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`设备更新接口 HTTP ${response.status}`);
    const info = await response.json();
    const latest = String(info?.latest_version || '').trim();
    if (!info?.update_available || !latest || !info.release_page_url) return { available: false };
    const releasePage = validatedReleasePage(base, info.release_page_url);
    const noticeKey = `${new URL(base).origin}|${latest}`;
    const notices = readNoticeKeys(this.filePath);
    if (notices.includes(noticeKey)) return { available: true, notified: false };
    atomicWrite(this.filePath, { schemaVersion: 1, notices: [...notices.slice(-(MAX_NOTICES - 1)), noticeKey] });
    const accepted = await this.confirmDownload({
      version: latest,
      releaseNotes: String(info.release_notes || ''),
      releasePageUrl: releasePage,
    });
    if (accepted) await this.openExternal(releasePage);
    return { available: true, notified: true, opened: accepted === true };
  }
}

function createDeviceHallUpdateChecker(options) {
  return new DeviceHallUpdateChecker(options);
}

module.exports = { DeviceHallUpdateChecker, createDeviceHallUpdateChecker, validatedReleasePage };

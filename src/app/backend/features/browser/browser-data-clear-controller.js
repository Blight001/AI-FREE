'use strict';

const { resolveTabTitle } = require('../../services/tab-common');

function getClearRequestOwner(ui, sender) {
  const senderId = sender?.id;
  if (senderId === undefined) return null;
  const sideOwner = createLiveContentsOwner(ui?.getSideView?.()?.webContents, senderId, 'sidebar');
  if (sideOwner) return sideOwner;
  const mainWindow = ui?.getMainWindow?.();
  const mainContents = mainWindow && !mainWindow.isDestroyed?.() ? mainWindow.webContents : null;
  return createLiveContentsOwner(mainContents, senderId, 'main');
}

function createLiveContentsOwner(contents, senderId, kind) {
  if (!contents || contents.id !== senderId || contents.isDestroyed?.()) return null;
  return { contents, kind };
}

function browserDataClearCapability(ui, profileId) {
  const manager = ui?.browserRuntimeManager;
  return Boolean(profileId && manager && typeof manager.clearData === 'function');
}

function validateBrowserDataClearRequest(ui, event, payload) {
  const profileId = String(payload?.profileId || '').trim();
  if (!browserDataClearCapability(ui, profileId)) return { error: { ok: false, message: '当前浏览器不支持清空数据' } };
  const tab = ui?.getTabs?.().get?.(profileId);
  if (!tab) return { error: { ok: false, message: '浏览器窗口不存在' } };
  const owner = getClearRequestOwner(ui, event?.sender);
  if (!owner) return { error: { ok: false, message: '只能从主窗口或侧边栏发起清空操作' } };
  return { profileId, tab, ...owner };
}

function validateBrowserDataClearResolution(ui, event, payload, pendingRequests) {
  const requestId = String(payload?.requestId || '').trim();
  const pending = pendingRequests.get(requestId);
  if (!pending) return { error: { ok: false, message: '清空请求已失效，请重新操作' } };
  const owner = getClearRequestOwner(ui, event?.sender);
  if (!owner || owner.kind !== pending.ownerKind || owner.contents.id !== pending.ownerContentsId) {
    return { error: { ok: false, message: '只能由发起清空操作的窗口确认' } };
  }
  return { requestId, pending };
}

function createBrowserDataClearController(ui, closeContextMenu) {
  const pendingRequests = new Map();

  async function request(event, payload = {}) {
    try {
      const validated = validateBrowserDataClearRequest(ui, event, payload);
      if (!('contents' in validated)) return validated.error;
      const { profileId, tab, contents, kind } = validated;
      closeContextMenu();
      if (kind === 'sidebar') ui?.ensureSidebarVisible?.();
      const requestId = `browser-data-clear-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const timeout = setTimeout(() => pendingRequests.delete(requestId), 120000);
      const pending = {
        profileId,
        timeout,
        ownerKind: kind,
        ownerContentsId: contents.id,
      };
      pendingRequests.set(requestId, pending);
      try {
        contents.send('browser-data-clear-confirm-request', { requestId, profileId, title: resolveTabTitle(tab) });
      } catch (error) {
        clearTimeout(pending.timeout);
        pendingRequests.delete(requestId);
        throw error;
      }
      return { ok: true, pending: true };
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  }

  async function resolve(event, payload = {}) {
    const validated = validateBrowserDataClearResolution(ui, event, payload, pendingRequests);
    if (validated.error) return validated.error;
    const { requestId, pending } = validated;
    clearTimeout(pending.timeout);
    pendingRequests.delete(requestId);
    if (payload?.confirmed !== true) return { ok: true, cancelled: true };
    try {
      if (!ui?.getTabs?.().get?.(pending.profileId)) return { ok: false, message: '浏览器窗口不存在' };
      const state = await ui.browserRuntimeManager.clearData(pending.profileId);
      return { ok: true, state };
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  }

  return { request, resolve };
}

module.exports = { createBrowserDataClearController };

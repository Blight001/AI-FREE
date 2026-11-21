'use strict';

const text = (value) => String(value ?? '').trim();
const COMMANDS = Object.freeze({ close: 'close-tab', back: 'history-back', forward: 'history-forward' });
const failed = (result) => result?.success === false || result?.ok === false;

function tabTarget(args) {
  const raw = args.index ?? args.tab_index ?? args.id ?? args.tab_id ?? args.tabId;
  if (raw === undefined || raw === null || raw === '') return { url: text(args.url), index: -1 };
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 0) throw new Error('标签 id/index 必须是 list 返回的非负整数');
  return { url: text(args.url), index };
}

function clearPageState(service, connection) {
  service.observeTargets.delete(connection.id);
  service.observationHistory.delete(connection.id);
}

function unsupportedRuntime(error) {
  return ['COMMAND_NOT_ALLOWED', 'COMMAND_UNKNOWN', 'UNKNOWN_COMMAND'].includes(text(error?.code || error?.errorCode));
}

async function tabCommand(service, connection, command, target) {
  try {
    const result = await service.runtimeCommand(connection, command, target);
    if (!unsupportedRuntime(result)) return result;
  } catch (error) {
    if (!unsupportedRuntime(error)) throw error;
  }
  return { success: false, errorCode: 'BROWSER_RUNTIME_UPDATE_REQUIRED',
    error: '当前 Chromium 内核未实现标签关闭/历史导航，请更新内核后重试。', retryable: false };
}

async function switchTab(service, connection, target) {
  let switched;
  if (target.url || target.index >= 0) switched = await service.runtimeCommand(connection, 'activate-tab', target);
  else {
    const listed = await service.runtimeCommand(connection, 'list-tabs');
    if (failed(listed)) return listed;
    switched = listed?.activeTab;
    if (!switched) return { success: false, errorCode: 'ACTIVE_TAB_UNAVAILABLE', error: '当前没有可切换的活动标签页' };
  }
  if (failed(switched)) return switched;
  clearPageState(service, connection);
  const focused = runtimePayload(await service.runtime.focus(connection.profileId, 'chromium'));
  if (failed(focused)) return focused;
  return { success: true, action: 'switch', ...switched };
}

function runtimePayload(result) { return result?.result || result; }

async function replaceTab(service, connection, url) {
  const result = runtimePayload(await service.runtime.navigate(connection.profileId, 'chromium', url));
  if (failed(result)) return result;
  clearPageState(service, connection);
  return null;
}

async function openTab(service, connection, url) {
  const opened = runtimePayload(await service.runtime.openTabs(connection.profileId, 'chromium', [url]));
  if (failed(opened)) return opened;
  clearPageState(service, connection);
  const focused = runtimePayload(await service.runtime.focus(connection.profileId, 'chromium'));
  if (failed(focused)) return focused;
  return null;
}

async function navigateTab(service, connection, args, action, target, normalizeUrl) {
  // Validate the destination before activating a requested tab. A malformed URL
  // must not move focus or invalidate the current observation snapshot.
  const url = action === 'reload' ? '' : normalizeUrl(args.url);
  if (target.index >= 0 && action !== 'navigate') {
    const selected = await service.runtimeCommand(connection, 'activate-tab', { index: target.index, url: '' });
    if (failed(selected)) return selected;
    clearPageState(service, connection);
  }
  if (action === 'reload') {
    const result = await service.runtime.reload(connection.profileId, 'chromium');
    const payload = result?.result || result;
    if (failed(payload)) return payload;
    clearPageState(service, connection);
    return { success: true, action, id: connection.profileId, ...payload };
  }
  const result = action === 'replace'
    ? await replaceTab(service, connection, url)
    : await openTab(service, connection, url);
  if (result) return result;
  return { success: true, action, id: connection.profileId, url,
    cardStep: { name: `打开 ${new URL(url).hostname}`, type: 'navigate', url } };
}

async function executeBrowserTab(service, connection, args, normalizeUrl) {
  let action = text(args.action).toLowerCase();
  if (action === 'navigate' && [args.replace_current, args.current_tab, args.same_tab].includes(true)) action = 'replace';
  if (!['list', 'switch', 'replace', 'navigate', 'reload', ...Object.keys(COMMANDS)].includes(action)) {
    throw new Error(`browser_tab 不支持的原生操作: ${action || '(空)'}`);
  }
  if (action === 'list') return service.runtimeCommand(connection, 'list-tabs');
  const target = tabTarget(args);
  if (COMMANDS[action]) {
    const result = await tabCommand(service, connection, COMMANDS[action], { index: target.index });
    if (!failed(result)) clearPageState(service, connection);
    return { action, ...result };
  }
  if (action === 'switch') return switchTab(service, connection, target);
  return navigateTab(service, connection, args, action, target, normalizeUrl);
}

module.exports = { executeBrowserTab, clearPageState };

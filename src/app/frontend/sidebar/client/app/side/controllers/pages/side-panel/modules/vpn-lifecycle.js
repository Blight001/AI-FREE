// 获取/读取/解析：getNetworkMagicAutoStartEnabled的具体业务逻辑。
async function getNetworkMagicAutoStartEnabled() {
  if (typeof window.aiFree?.network?.getAutoStartEnabled !== 'function') {
    return true;
  }
  try {
    const result = await window.aiFree.network.getAutoStartEnabled();
    if (result && result.ok === true && typeof result.enabled === 'boolean') {
      return result.enabled;
    }
  } catch (_) {}
  return true;
}

// 设置/更新/持久化：persistNetworkMagicAutoStartEnabled的具体业务逻辑。
async function persistNetworkMagicAutoStartEnabled(enabled) {
  if (typeof window.aiFree?.network?.setAutoStartEnabled !== 'function') {
    return { ok: false };
  }
  return window.aiFree.network.setAutoStartEnabled( { enabled: !!enabled });
}

function normalizeNetworkMagicProxyMode(value) {
  const mode = String(value || '').trim();
  return ['port', 'system', 'global'].includes(mode) ? mode : 'port';
}

async function readSavedNetworkMagicProxyMode() {
  const result = await window.aiFree?.network?.getProxyMode?.();
  return normalizeNetworkMagicProxyMode(result?.mode);
}

// 停止/关闭/清理：stopClashMiniFlow的具体业务逻辑。
async function stopClashMiniFlow() {
  if (typeof window.aiFree.network.stopClash !== 'function') {
    throw new Error('当前环境不支持停止 Clash Mini');
  }
  const result = await window.aiFree.network.stopClash();
  if (!result || result.ok !== true) {
    throw new Error((result && (result.error || result.message)) || '关闭网络魔法失败');
  }
  await persistNetworkMagicAutoStartEnabled(false).catch(() => {});
  applyClashMiniStatus(result);
}

// 完整启动流程（单次执行体，勿直接调用，统一走 startClashMiniFlow）：
//  1. 需要刷新配置且核心已在运行时，先停掉旧进程；
//  2. 拉取并导入服务器最新 Clash 配置（手动开启时强制刷新）；
//  3. 启动核心并应用代理模式；
//  4. 记忆“自动启动”偏好；
//  5. 获取节点；主进程复用已有测速记录，只补测没有记录的节点；
async function startClashMiniFlowOnce({ fetchConfig = true, key = '', deviceId = '', proxyMode = '' } = {}) {
  if (typeof window.aiFree.network.startClash !== 'function') {
    throw new Error('当前环境不支持启动 Clash Mini');
  }
  await stopClashForFreshConfig(fetchConfig);
  if (fetchConfig) {
    // 获取服务器配置只能发生在真正启动网络魔法的流程里。个人中心、账号
    // 恢复和普通侧边栏初始化都不得单独预热或刷新代理配置。
    console.log('[侧边栏][Clash] 开启网络魔法，获取最新 YAML 并覆盖旧配置...');
    await ensureClashMiniConfigPreheated({ force: true, key, deviceId });
  }
  const mode = proxyMode || await readSavedNetworkMagicProxyMode();
  const result = await window.aiFree.network.startClash({ proxyMode: mode });
  assertClashStarted(result);

  await persistNetworkMagicAutoStartEnabled(true).catch(() => {});
  applyClashMiniStatus(result, { loadProxyOptions: false });
  await loadVpnNodeSelectorOptions({ force: true, probeDelays: true });
}

async function stopClashForFreshConfig(fetchConfig) {
  if (!fetchConfig || typeof window.aiFree.network.stopClash !== 'function') return;
  const currentStatus = typeof window.aiFree.network.getClashStatus === 'function'
    ? await window.aiFree.network.getClashStatus().catch(() => null)
    : null;
  if (currentStatus?.running !== true) return;
  const result = await window.aiFree.network.stopClash()
    .catch((error) => ({ ok: false, error: error?.message || String(error) }));
  if (!result?.ok) {
    throw new Error(result?.error || result?.message || '重启网络魔法前停止当前进程失败');
  }
}

function assertClashStarted(result) {
  if (result?.ok === true) return;
  const error = new Error(result?.error || result?.message || '启动网络魔法失败');
  if (result?.cancelled === true) {
    error.code = 'CLASH_MINI_START_CANCELLED';
    error.cancelled = true;
  }
  throw error;
}

// 启动流程的统一入口。恢复状态、验证后自动开启和手动点击可能在相邻时刻
// 同时触发：共享同一个启动任务，核心只启动一次，后台自动选路也只跑一次。
// clashMiniStartFlowPromise 同时是“启动流程进行中”的状态标记，
// applyVpnActionAvailability 靠它在整个流程期间保持选路按钮禁用。
function startClashMiniFlow(options = {}) {
  if (clashMiniStartFlowPromise) {
    return clashMiniStartFlowPromise;
  }

  const sharedPromise = startClashMiniFlowOnce(options).finally(() => {
    if (clashMiniStartFlowPromise === sharedPromise) {
      clashMiniStartFlowPromise = null;
    }
    // 流程结束后重新收敛，失败时回落到“未开启”状态。
    applyVpnActionAvailability();
  });
  clashMiniStartFlowPromise = sharedPromise;
  // 流程开始立即禁用选路按钮，堵住启动期间状态事件带来的可点击空窗。
  applyVpnActionAvailability();
  return sharedPromise;
}

function showNetworkMagicOperationError(error) {
  // 软件退出会主动取消尚未完成的 Clash Mini 启动，并关闭相关 socket。
  // 这是预期清理，不应再弹错误框打断退出流程。
  if (
    window.__aiFreeAppClosing === true
    || error?.cancelled === true
    || error?.code === 'CLASH_MINI_START_CANCELLED'
  ) {
    return;
  }
  const message = String(error?.message || error || '网络魔法操作失败').trim() || '网络魔法操作失败';
  console.error('[侧边栏][Clash] 网络魔法操作失败:', message);
  if (window.MessageModal && typeof window.MessageModal.showErrorMessage === 'function') {
    window.MessageModal.showErrorMessage(message);
    return;
  }
  if (typeof window.alert === 'function') window.alert(message);
}

// 自动开启网络魔法的统一入口（面板初始化恢复 / 登录成功 / 恢复登录态共用）。
// 满足以下条件才会启动：账号已登录、用户开启了“自动启动”记忆、核心未在运行、
// 且用户没有正在手动操作开关。key/deviceId 缺省时由预热流程自行解析。
async function autoStartNetworkMagicIfEligible({ key = '', deviceId = '' } = {}) {
  if (!window.aiFree?.network || autoStartClashMiniInFlight || vpnControlOperation) return;

  // 从条件评估阶段就置位“进行中”：预热启动（warmup）等并行流程推送的
  // 状态事件即使在评估期间到达，选路按钮也不会被放开一瞬。
  autoStartClashMiniInFlight = true;
  try {
    applyVpnActionAvailability();
    if (!await getNetworkMagicAutoStartEnabled()) return;
    const identity = await resolveNetworkMagicAutoStartIdentity(key, deviceId);
    if (!identity.eligible || await isNetworkMagicRunning()) return;

    console.log('[侧边栏][Clash] 检测到上次为开启状态，自动启用网络魔法');
    await startClashMiniFlow({
      fetchConfig: true,
      key: identity.key,
      deviceId: identity.deviceId,
    });
  } catch (error) {
    console.warn('[侧边栏] 自动开启网络魔法失败:', error?.message || error);
  } finally {
    autoStartClashMiniInFlight = false;
    // 无论正常结束还是提前退出，都重新收敛一次按钮可用性。
    applyVpnActionAvailability();
  }
}

async function resolveNetworkMagicAutoStartIdentity(key = '', deviceId = '') {
  if (hasValidatedInSession || isLicenseValidated()) {
    return { eligible: true, key, deviceId };
  }
  const credentials = await readNetworkMagicSavedCredentials();
  return {
    eligible: credentials.validated === true && credentials.bound === true,
    key: String(key || credentials.key || '').trim(),
    deviceId: String(deviceId || credentials.deviceId || '').trim(),
  };
}

async function readNetworkMagicSavedCredentials() {
  const getter = window.aiFree?.license?.getUserCredentials;
  if (typeof getter !== 'function') return {};
  const response = await getter().catch(() => null);
  return response?.ok === true && response.credentials ? response.credentials : {};
}

async function isNetworkMagicRunning() {
  if (typeof window.aiFree.network.getClashStatus !== 'function') return false;
  const status = await window.aiFree.network.getClashStatus().catch(() => null);
  return status?.running === true;
}

let networkMagicAccountSessionRevision = 0;

function applyNetworkMagicAccountSession(session = {}) {
  document.documentElement.dataset.accountAuthenticated = String(session?.authenticated === true);
  if (typeof syncLatencyButtonState === 'function') syncLatencyButtonState();
  if (typeof syncLoggedOutProtectedEntryAvailability === 'function') {
    syncLoggedOutProtectedEntryAvailability();
  }
}

// app-shell 设置页没有账号资料卡，也不会走账号中心的初始化分支。
// 主进程自动恢复登录并不等于页面上的 accountAuthenticated 已同步；
// 若网络魔法随后自动启动，节点选择按钮会一直被误判为“未登录”。
function bindNetworkMagicAccountSession() {
  const accountApi = window.aiFree?.account;
  if (!accountApi || document.documentElement.dataset.networkMagicAccountBound === '1') return;
  document.documentElement.dataset.networkMagicAccountBound = '1';

  if (typeof accountApi.onSessionUpdated === 'function') {
    accountApi.onSessionUpdated((session) => {
      networkMagicAccountSessionRevision += 1;
      applyNetworkMagicAccountSession(session);
    });
  }

  if (typeof accountApi.getSession !== 'function') return;
  const requestRevision = networkMagicAccountSessionRevision;
  accountApi.getSession().then((session) => {
    // 会话事件比初始读取更新时，不允许较旧的读取结果覆盖它。
    if (requestRevision !== networkMagicAccountSessionRevision) return;
    applyNetworkMagicAccountSession(session);
  }).catch(() => {});
}

// 同步/连接：bindClashMiniControls的具体业务逻辑。
function bindClashMiniControls(render, renderGroups) {
  bindClashNodeControls();
  onVpnControlsChanged = render;
  renderVpnNodeGroups = renderGroups;
  bindNetworkMagicAccountSession();
  bindClashStatusHandlers();
  bindAppClosingGuard();
  if (window.aiFree?.network) autoStartNetworkMagicIfEligible().catch(() => {});
}

function bindClashNodeControls() {
  testLatencyBtn = safeGetEl('vpn-node-retest-all-btn');
  vpnNodeSelectorToggleBtn = safeGetEl('vpn-node-selector-toggle-btn');
  vpnNodeSelectorPanel = safeGetEl('vpn-node-selector-panel');
  vpnNodeSelectorGrid = safeGetEl('vpn-node-selector-grid');
  vpnNodeSelectorGroup = safeGetEl('vpn-node-selector-group');
}

function bindClashStatusHandlers() {
  if (window.__clashMiniConsoleBound || typeof window.aiFree?.network?.onClashStatus !== 'function') return;
  window.aiFree.network.onAppShuttingDown(() => { window.__aiFreeAppClosing = true; });
  window.aiFree.network.onClashStatus((status) => {
    if (!vpnControlOperation) applyClashMiniStatus(status);
  });
  window.aiFree.network.onProxyTrafficExhausted(() => {
    window.MessageModal?.showErrorMessage?.('网络魔法流量已用完，代理已自动关闭。请到个人中心兑换流量。');
  });
  window.aiFree.network.onClashRuntimeFailed((payload = {}) => {
    applyClashMiniStatus({ running: false, enabled: false });
    if (window.__aiFreeAppClosing !== true) {
      window.MessageModal?.showErrorMessage?.(payload.message || '网络魔法运行异常，代理已关闭。');
    }
  });
  window.aiFree.network.onClashLatencyProgress(applyClashMiniLatencyProgress);
  window.__clashMiniConsoleBound = true;
}

function bindAppClosingGuard() {
  if (window.__aiFreeClosingGuardBound) return;
  window.__aiFreeClosingGuardBound = true;
  window.addEventListener('beforeunload', () => { window.__aiFreeAppClosing = true; });
}

async function refreshClashStatus() {
  const status = await window.aiFree.network.getClashStatus();
  applyClashMiniStatus(status);
  return status;
}

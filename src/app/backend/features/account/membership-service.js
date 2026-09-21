'use strict';

const { buildStoredAccountSession, normalizeAccountSession } = require('../../utils/account-session');
const { getServerMode, isServerBaseAllowedForMode } = require('../../utils/server-mode');
const { clearVipServerVerification, markVipServerVerified } = require('../../utils/vip-access');
const { setLicenseRuntimeConfig } = require('../../utils/runtime-config');
const { callOptional, firstText } = require('../../../shared/safe-values');

const MEMBERSHIP_RECOVERY_RETRY_MS = 30 * 1000;

function getTutorialUrl(licenseCache) {
  const runtimeConfig = callOptional(licenseCache, 'getRuntimeConfig') || {};
  return firstText(runtimeConfig.tutorialUrl).trim();
}

async function validateMembership(deps, credentials) {
  const client = callOptional(deps, 'getGlobalHttpClient');
  if (client && Object.prototype.hasOwnProperty.call(client, 'runtimeServerBase')) {
    client.runtimeServerBase = firstText(credentials.serverBase).trim().replace(/\/+$/, '');
  }
  if (!client || typeof client.validateSession !== 'function') return null;
  return client.validateSession(credentials.key, credentials.deviceId);
}

function resolveMembershipState(credentials, response) {
  const verified = response?.valid === true;
  const transientFailure = !response
    || Number(response?.status) === 0
    || Number(response?.status) >= 500
    || response?.retryable === true;
  if (!verified && transientFailure) {
    return {
      verified: false,
      transientFailure: true,
      validation: markVipServerVerified(credentials.validation),
      account: markVipServerVerified(credentials.account),
    };
  }
  const validation = verified
    ? markVipServerVerified(response)
    : clearVipServerVerification(credentials.validation);
  const account = verified
    ? markVipServerVerified({
      ...credentials.account,
      is_vip: response.is_vip === true,
      vip_active: response.vip_active === true || response.is_vip === true,
      vip_tier: response.vip_tier || null,
      vip_expiry_date: response.vip_expiry_date || null,
    })
    : clearVipServerVerification(credentials.account);
  return { verified, transientFailure: false, validation, account };
}

function persistMembership(deps, credentials, state) {
  const currentStore = deps.readStoreConfigSafe();
  const storedSession = buildStoredAccountSession({
    current: currentStore?.userCredentials || {},
    username: credentials.username,
    sessionToken: credentials.key,
    deviceId: credentials.deviceId,
    platformName: credentials.platformName,
    serverBase: credentials.serverBase,
    serverMode: credentials.serverMode,
    account: state.account,
    validation: state.validation,
    authenticatedAt: credentials.authenticatedAt,
  });
  deps.writeStoreConfigSafe({ ...currentStore, userCredentials: storedSession });
  deps.licenseCache?.setCredentials?.({ key: credentials.key, deviceId: credentials.deviceId });
  const accessTrusted = state.verified || state.transientFailure;
  deps.licenseCache?.setValidationState?.({
    key: credentials.key,
    deviceId: credentials.deviceId,
    validated: accessTrusted,
    bound: accessTrusted,
    licenseValidated: accessTrusted,
    result: state.validation,
    message: state.verified
      ? '会员状态已由服务器验证'
      : (state.transientFailure ? '网络暂时不可用，已保留最近确认的会员状态' : '会员状态已由服务器拒绝'),
  });
  setLicenseRuntimeConfig(deps.licenseCache, state.validation);
  deps.licenseCache?.setRuntimeConfig?.({ autoValidatePending: false });
}

function notifyMembershipResult(deps, credentials, state, reason, response) {
  if (reason !== 'startup') {
    deps.sendToSide?.('account-session-updated', {
      authenticated: true,
      username: credentials.username,
      platformName: credentials.platformName,
      account: state.account,
      validation: state.validation,
    });
  }
  if (state.transientFailure) {
    deps.logger.warn?.('[会员] 在线验证遇到临时网络故障，保留最近确认状态并等待重试:', response?.message || response?.error || '服务不可用');
  } else if (!state.verified) {
    deps.logger.warn?.('[会员] 在线验证失败，本地 VIP 权限已关闭:', response?.message || response?.error || '服务不可用');
  }
}

function createMembershipRecoveryScheduler(deps, retry) {
  let timer = null;
  return {
    clear() {
      if (!timer) return;
      deps.clearTimeoutFn(timer);
      timer = null;
    },
    schedule(credentials) {
      if (timer) return;
      timer = deps.setTimeoutFn(() => {
        timer = null;
        void retry(credentials).catch((error) => {
          deps.logger.warn?.('[会员] 网络恢复重试失败:', error?.message || error);
          this.schedule(credentials);
        });
      }, MEMBERSHIP_RECOVERY_RETRY_MS);
      timer?.unref?.();
    },
  };
}

function createMembershipService(deps = {}) {
  /** @type {Record<string, any>} */
  const normalized = {
    ...deps,
    logger: deps.logger || console,
    setIntervalFn: deps.setIntervalFn || setInterval,
    setTimeoutFn: deps.setTimeoutFn || setTimeout,
    clearTimeoutFn: deps.clearTimeoutFn || clearTimeout,
  };
  let refreshInFlight = null;
  const recovery = createMembershipRecoveryScheduler(normalized, (credentials) => refresh(credentials, 'recovery'));

  async function performRefresh(credentials, reason) {
    const previousTutorialUrl = getTutorialUrl(normalized.licenseCache);
    const response = await validateMembership(normalized, credentials);
    const state = resolveMembershipState(credentials, response);
    if (state.transientFailure) recovery.schedule(credentials);
    else recovery.clear();
    persistMembership(normalized, credentials, state);
    const nextTutorialUrl = getTutorialUrl(normalized.licenseCache);
    if (state.verified && nextTutorialUrl && nextTutorialUrl !== previousTutorialUrl) {
      await Promise.resolve(callOptional(normalized, 'refreshAllowedPlatformsAndNotify'));
    }
    notifyMembershipResult(normalized, credentials, state, reason, response);
    return state;
  }

  async function refresh(credentials, reason = 'startup') {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = performRefresh(credentials, reason);
    try { return await refreshInFlight; } finally { refreshInFlight = null; }
  }

  function scheduleRefresh() {
    const timer = normalized.setIntervalFn(() => {
      const current = normalizeAccountSession(normalized.readStoreConfigSafe()?.userCredentials || {});
      if (current.authenticated) {
        void refresh(current, 'periodic').catch((error) => {
          normalized.logger.warn?.('[会员] 定时验证失败:', error?.message || error);
        });
      }
    }, 5 * 60 * 1000);
    timer?.unref?.();
    return timer;
  }

  async function restore() {
    const credentials = normalizeAccountSession(normalized.readStoreConfigSafe()?.userCredentials || {});
    const serverMode = getServerMode();
    const canRestore = credentials.authenticated
      && credentials.serverMode === serverMode
      && isServerBaseAllowedForMode(credentials.serverBase, serverMode);
    if (!canRestore) {
      if (credentials.authenticated) {
        normalized.logger.log?.(`[账号] 已忽略 ${credentials.serverMode} 模式的历史登录状态，当前为 ${serverMode} 模式`);
      }
      return { restored: false };
    }
    normalized.applyResolvedConfigToStore?.({
      resolved: {
        ...credentials.validation,
        serverBase: credentials.serverBase,
        platformName: credentials.platformName,
      },
    });
    const state = await refresh(credentials, 'startup');
    const restoreLabel = state.verified ? '(会员已在线验证)'
      : (state.transientFailure ? '(网络异常，已保留最近会员状态)' : '(会员状态已失效)');
    normalized.logger.log?.('[账号] 已恢复账号登录状态:', credentials.username, restoreLabel);
    return { restored: true, state, timer: scheduleRefresh() };
  }

  return { refresh, restore, scheduleRefresh };
}

module.exports = {
  MEMBERSHIP_RECOVERY_RETRY_MS,
  createMembershipService,
  notifyMembershipResult,
  persistMembership,
  resolveMembershipState,
};

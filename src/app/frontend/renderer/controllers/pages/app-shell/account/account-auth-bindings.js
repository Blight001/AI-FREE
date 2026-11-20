function bindAccountDialogControls() {
  safeGetEl('sidebar-auth-mode-switch')?.addEventListener('click', (event) => {
    setSidebarAuthMode(event.currentTarget?.dataset.targetMode);
  });
  document.querySelectorAll('[data-vip-benefits-close]').forEach((element) => element.addEventListener('click', closeVipBenefitsDialog));
  safeGetEl('account-profile-avatar')?.addEventListener('click', toggleAccountProfileMenu);
  safeGetEl('account-profile-menu')?.addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', closeAccountProfileMenu);
  document.addEventListener('keydown', closeAccountDialogOnEscape);
}

function closeAccountDialogOnEscape(event) {
  if (event.key !== 'Escape') return;
  if (safeGetEl('vip-benefits-dialog')?.hidden === false) closeVipBenefitsDialog();
}

function bindVipPlanControls() {
  safeGetEl('vip-plan-list')?.addEventListener('click', (event) => {
    const option = event.target?.closest?.('.vip-plan-option');
    if (option?.dataset?.vipPlan) selectVipPlan(option.dataset.vipPlan);
  });
  safeGetEl('vip-tier-tabs')?.addEventListener('click', (event) => {
    const tierButton = event.target?.closest?.('[data-vip-tier]');
    if (tierButton?.dataset?.vipTier) renderVipPlanTier(tierButton.dataset.vipTier);
  });
  safeGetEl('vip-use-gift-code')?.addEventListener('click', () => {
    closeVipBenefitsDialog();
    safeGetEl('unified-gift-code')?.focus?.();
  });
  safeGetEl('account-vip-card')?.addEventListener('click', openVipAccountCenter);
  safeGetEl('unified-redeem-gift')?.addEventListener('click', redeemUnifiedGiftCode);
  safeGetEl('unified-gift-code')?.addEventListener('keydown', redeemGiftCodeOnEnter);
}

function redeemGiftCodeOnEnter(event) {
  if (event.key === 'Enter') void redeemUnifiedGiftCode();
}

function bindAccountAuthControls() {
  safeGetEl('sidebar-auth-submit')?.addEventListener('click', submitSidebarAccountAuth);
  safeGetEl('sidebar-device-login')?.addEventListener('click', submitSidebarDeviceLogin);
  safeGetEl('account-logout-btn')?.addEventListener('click', logoutSidebarAccount);
  ['sidebar-auth-username', 'sidebar-auth-password', 'sidebar-auth-password-confirm'].forEach((id) => {
    safeGetEl(id)?.addEventListener('keydown', submitAccountAuthOnEnter);
  });
}

function submitAccountAuthOnEnter(event) {
  if (event.key === 'Enter') void submitSidebarAccountAuth();
}

function subscribeAccountApi(api, method, handler) {
  if (api && typeof api[method] === 'function') api[method](handler);
}

function bindAccountApiEvents() {
  const rootApi = window.aiFree || {};
  subscribeAccountApi(rootApi.account, 'onSessionUpdated', handleAccountSessionUpdate);
  subscribeAccountApi(rootApi.ui, 'onOpenAccountCenter', window.AppShellHome.openPersonal);
  subscribeAccountApi(rootApi.license, 'onVipAccessRequired', openVipAccountCenter);
}

let accountSessionRevision = 0;

function handleAccountSessionUpdate(session = {}) {
  accountSessionRevision += 1;
  renderSidebarAccountSession(session);
  if (vipPlansOpenRequested && session.authenticated === true) openVipBenefitsDialog();
}

function initializeAccountSessionView() {
  setSidebarAuthMode('login');
  const currentRevision = accountSessionRevision;
  window.aiFree?.account?.getSession?.().then((session) => {
    if (currentRevision === accountSessionRevision) handleAccountSessionUpdate(session || {});
  }).catch(() => {
    if (currentRevision === accountSessionRevision) handleAccountSessionUpdate({ authenticated: false });
  });
}

function bindSidebarAccountAuth() {
  const modal = safeGetEl('sidebar-account-auth');
  if (!modal || modal.dataset.bound === '1') return;
  modal.dataset.bound = '1';
  bindAccountDialogControls();
  bindVipPlanControls();
  bindAccountAuthControls();
  bindAccountApiEvents();
  initializeAccountSessionView();
}

function bindHomeAccountRuntime() {
  if (!window.aiFree?.ui) return;

  window.aiFree.ui.onDeviceIdUpdated((deviceId) => {
    try {
      const deviceIdInput = document.getElementById('device-id');
      if (deviceIdInput) {
        deviceIdInput.value = deviceId || '';
      }
    } catch (e) {
      console.warn('更新设备号失败:', e);
    }
  });

  window.aiFree.ui.onLicenseUsageUpdated((usage) => {
    try {
      const usageText = formatUsageTimesText(usage);
      if (typeof setWoolPlatformRemainingUsage === 'function') {
        const usagePayload = usage?.licenseUsage || usage?.result || usage || {};
        const platform = usagePayload.platform || usagePayload.platform_name || usagePayload.currentPlatform || '';
        setWoolPlatformRemainingUsage(usageText, platform);
      }
    } catch (e) {
      console.warn('更新本地试用次数显示失败:', e);
    }
  });
}

function createNetworkMagicPopupLayout(root, power, onSettled) {
  const details = [...root.querySelectorAll('.magic-controls, .magic-nodes')];
  let size = 'compact';

  function resize(nextSize) {
    if (nextSize === size) return;
    size = nextSize;
    window.aiFree.shell.toggleNetworkMagicPanel({ open: true, size });
  }

  function update(open, large, animate) {
    const detailSize = large ? 'expanded' : 'details';
    if (root.hasAttribute('data-open') === open) {
      if (open) resize(detailSize);
      return;
    }
    if (open) resize(detailSize);
    details.forEach((part) => { part.hidden = true; });
    root.toggleAttribute('data-moving', animate);
    power.getBoundingClientRect();
    root.toggleAttribute('data-open', open);
    power.getBoundingClientRect();
    const animations = power.getAnimations();
    const settle = () => {
      root.removeAttribute('data-moving');
      details.forEach((part) => { part.hidden = !open; });
      if (!open) resize('compact');
    };
    if (!animations.length) {
      settle();
      return;
    }
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (root.hasAttribute('data-open') !== open) return;
      settle();
      onSettled();
    });
  }

  return update;
}

function createNetworkMagicPopupView(root, network) {
  const power = root.querySelector('#VPN-switch');
  const label = root.querySelector('[data-magic-power-label]');
  const modes = root.querySelector('#network-magic-proxy-mode');
  const inputs = [...modes.querySelectorAll('input')];
  const close = root.querySelector('[data-network-magic-close]');
  const hint = root.querySelector('[data-magic-node-hint]');
  const count = root.querySelector('[data-magic-node-count]');
  const updateLayout = createNetworkMagicPopupLayout(root, power, () => applyVpnActionAvailability());
  let mode = 'port';
  let ready = false;
  let animate = false;

  function renderDetails(visible, names, locked) {
    modes.disabled = locked;
    testLatencyBtn.disabled = locked;
    inputs.forEach((input) => { input.checked = input.value === mode; });
    if (visible) {
      vpnNodeSelectorPanel.hidden = !names.length;
      hint.hidden = names.length > 0;
      count.textContent = names.length ? String(names.length) : '';
    }
    vpnNodeSelectorGrid.querySelectorAll('button').forEach((node) => { node.disabled = locked; });
  }

  function render() {
    const operation = vpnControlOperation || (isNetworkMagicStartFlowActive() ? '正在开启…' : '')
      || (vpnNodeSelectorBusy ? '正在切换节点…' : '');
    if (operation) root.dataset.operation = operation;
    else delete root.dataset.operation;
    const open = root.hasAttribute('data-open');
    const visible = canUseVpnFeatures();
    const names = getVpnNodeSelectorNames();
    updateLayout(ready && (operation ? open : isVpnEnabled), names.length > 6, animate);
    const busy = Boolean(operation) || root.hasAttribute('data-moving');
    label.textContent = operation || (clashCoreRunning ? '关闭魔法代理' : '开启魔法代理');
    power.setAttribute('aria-pressed', String(isVpnEnabled));
    power.disabled = !ready || busy;
    close.disabled = busy;
    renderDetails(visible, names, !ready || busy || vpnNodeActionsLocked());
  }

  function setMode(next) { mode = normalizeNetworkMagicProxyMode(next); }
  function selectPersistedMode() {
    return readSavedNetworkMagicProxyMode().then(setMode).catch(showNetworkMagicOperationError);
  }
  function closePopup() {
    if (!close.disabled) window.aiFree.shell.toggleNetworkMagicPanel({ open: false });
  }
  function setReady() {
    ready = true;
    render();
    animate = true;
  }

  return { network, power, modes, close, render, closePopup, setMode, selectPersistedMode,
    getMode: () => mode, setReady };
}

async function runNetworkMagicPopupOperation(label, action) {
  if (vpnControlOperation || isNetworkMagicStartFlowActive() || vpnNodeSelectorBusy) return;
  vpnControlOperation = label;
  applyVpnActionAvailability();
  try {
    await action();
  } catch (error) {
    await refreshClashStatus().catch(showNetworkMagicOperationError);
    showNetworkMagicOperationError(error);
  } finally {
    vpnControlOperation = '';
    applyVpnActionAvailability();
  }
}

async function switchNetworkMagicPopupMode(view, nextMode) {
  const stopped = await view.network.stopClash();
  if (!stopped?.ok) throw new Error(stopped?.error || '切换代理模式前停止网络魔法失败');
  await startClashMiniFlow({ fetchConfig: false, proxyMode: nextMode });
  view.setMode(nextMode);
  const saved = await view.network.setProxyMode({ mode: nextMode });
  if (!saved?.ok) throw new Error(saved?.error || '保存代理模式失败');
}

function bindNetworkMagicPopupActions(view) {
  const run = runNetworkMagicPopupOperation;
  view.power.addEventListener('click', () => {
    if (view.power.disabled) return;
    const stopping = clashCoreRunning;
    void run(stopping ? '正在关闭…' : '正在开启…', async () => {
      if (await redirectToAccountLogin()) return;
      if (stopping) await stopClashMiniFlow();
      else await startClashMiniFlow({ proxyMode: view.getMode() });
    });
  });
  view.modes.addEventListener('change', (event) => {
    const nextMode = event.target.value;
    if (view.modes.disabled || nextMode === view.getMode()) return;
    void run('正在切换模式…', () => switchNetworkMagicPopupMode(view, nextMode));
  });
  testLatencyBtn.addEventListener('click', () => {
    if (!testLatencyBtn.disabled) void run('正在测速…', async () => {
      await retestVpnNodes();
      await refreshClashStatus();
    });
  });
  view.close.addEventListener('click', view.closePopup);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented) view.closePopup();
  });
}

function bindNetworkMagicPopupPage() {
  const root = document.getElementById('network-magic-sidebar-dialog');
  if (!root || !window.aiFree?.network) return;
  window.MessageModal.initServerMessageListener();
  const view = createNetworkMagicPopupView(root, window.aiFree.network);
  bindClashMiniControls(view.render, addNetworkMagicNodeGroups);
  bindNetworkMagicPopupActions(view);
  void Promise.all([view.selectPersistedMode(), refreshClashStatus().catch(showNetworkMagicOperationError)])
    .then(([, status]) => {
      if (status?.running && status.proxyMode) view.setMode(status.proxyMode);
      view.setReady();
    });
  window.aiFree?.ui?.onAppThemeChanged?.((theme) => {
    const nextTheme = String(theme || '').trim();
    document.documentElement.classList.toggle('theme-light', nextTheme !== 'dark' && nextTheme !== 'gold');
    document.documentElement.classList.toggle('theme-gold', nextTheme === 'gold');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindNetworkMagicPopupPage);
} else {
  bindNetworkMagicPopupPage();
}

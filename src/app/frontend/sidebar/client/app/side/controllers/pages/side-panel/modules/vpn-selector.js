function setVpnNodeSelectorBusy(busy) {
  vpnNodeSelectorBusy = busy === true;
  applyVpnActionAvailability();
  if (vpnNodeSelectorGrid) {
    vpnNodeSelectorGrid.classList.toggle('is-busy', vpnNodeSelectorBusy);
    vpnNodeSelectorGrid.querySelectorAll('button').forEach((button) => {
      button.disabled = renderVpnNodeGroups ? vpnNodeActionsLocked() : vpnNodeSelectorBusy;
    });
  }
}

// 同步/连接：syncVpnNodeSelectorState的具体业务逻辑。
function syncVpnNodeSelectorState() {
  if (!testLatencyBtn || !vpnNodeSelectorPanel) return;
  const enabled = canUseVpnFeatures();
  applyVpnActionAvailability();
  if (typeof renderVpnNodeGroups === 'function') return;
  if (!enabled) {
    setVpnNodeSelectorOpen(false);
    scheduleVpnNodeSelectorRender({ forceFull: true });
    return;
  }

  if (vpnNodeSelectorGroup) {
    vpnNodeSelectorGroup.textContent = String(clashMiniProxyState.groupName || '节点选择').trim() || '节点选择';
  }
}

// 渲染/刷新：renderVpnNodeSelectorOptions的具体业务逻辑。
function renderVpnNodeSelectorOptions() {
  if (!vpnNodeSelectorGrid) return;

  const names = getVpnNodeSelectorNames();
  const namesKey = buildVpnNodeSelectorNamesKey(names);
  const selectedName = getVpnNodeSelectorSelectedName();

  const grouped = typeof renderVpnNodeGroups === 'function';
  if (names.length === 0 && grouped) {
    vpnNodeSelectorGrid.replaceChildren();
    vpnNodeSelectorOptionNodes.clear();
    vpnNodeSelectorRenderedNamesKey = '';
    return;
  }
  if (names.length === 0) {
    vpnNodeSelectorOptionNodes.clear();
    vpnNodeSelectorRenderedNamesKey = '';
    vpnNodeSelectorGrid.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'vpn-node-option';
    empty.style.gridColumn = '1 / -1';
    empty.style.cursor = 'default';
    empty.setAttribute('aria-checked', 'false');
    const main = document.createElement('div');
    main.className = 'vpn-node-option-main';
    const nameEl = document.createElement('div');
    nameEl.className = 'vpn-node-option-name';
    nameEl.textContent = '暂无可用节点';
    const metaEl = document.createElement('div');
    metaEl.className = 'vpn-node-option-meta';
    metaEl.textContent = '请先启动网络魔法';
    main.append(nameEl, metaEl);
    const checkEl = document.createElement('span');
    checkEl.className = 'vpn-node-option-check';
    empty.append(main, checkEl);
    vpnNodeSelectorGrid.appendChild(empty);
    return;
  }

  const needsRebuild = vpnNodeSelectorRenderedNamesKey !== namesKey
    || vpnNodeSelectorOptionNodes.size !== names.length;
  if (needsRebuild) {
    vpnNodeSelectorOptionNodes.clear();
    vpnNodeSelectorGrid.innerHTML = '';
    vpnNodeSelectorRenderedNamesKey = namesKey;
    const buttons = names.map((name, index) => {
      const button = buildVpnNodeSelectorButton(name, index, getProxyItemByName(name), selectedName);
      vpnNodeSelectorOptionNodes.set(name, button);
      return button;
    });
    if (grouped) renderVpnNodeGroups(vpnNodeSelectorGrid, buttons);
    else vpnNodeSelectorGrid.append(...buttons);
    return;
  }

  names.forEach((name, index) => {
    const proxyItem = getProxyItemByName(name);
    let button = vpnNodeSelectorOptionNodes.get(name);
    if (!button || !vpnNodeSelectorGrid.contains(button)) {
      button = buildVpnNodeSelectorButton(name, index, proxyItem, selectedName);
      vpnNodeSelectorOptionNodes.set(name, button);
      vpnNodeSelectorGrid.appendChild(button);
      return;
    }
    updateVpnNodeSelectorButton(button, name, index, proxyItem, selectedName);
  });
}

// 设置/更新/持久化：applyClashMiniLatencyProgress的具体业务逻辑。
function applyClashMiniLatencyProgress(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (!isLatencyProgressForCurrentGroup(payload)) return;

  const nextBestName = String(payload.bestName || '').trim();
  const nextBestDelay = Number(payload.bestDelay);
  const hasBest = nextBestName && Number.isFinite(nextBestDelay) && nextBestDelay > 0;

  if (!Array.isArray(clashMiniProxyState.proxies)) clashMiniProxyState.proxies = [];

  if (payload.phase === 'done' && Array.isArray(payload.entries) && payload.entries.length > 0) {
    applyLatencyResultEntries(payload.entries);
    syncVpnNodeSelectorState();
    scheduleVpnNodeSelectorRender({ forceFull: true });
    return;
  }

  if (payload.phase === 'probe') updateLatencyProgressEntry(payload, hasBest ? nextBestName : '');
  if (hasBest) selectLatencyProgressBest(nextBestName);

  syncVpnNodeSelectorState();
  scheduleVpnNodeSelectorRender();
}

function applyLatencyResultEntries(entries) {
  const updates = new Map(normalizeProxyEntries(entries, clashMiniProxyState.current, '超时')
    .map((item) => [item.name, item]));
  clashMiniProxyState.proxies = clashMiniProxyState.proxies.map((item) => updates.get(item.name) || item);
}

function isLatencyProgressForCurrentGroup(payload) {
  if (!payload.groupName) return true;
  return String(payload.groupName).trim() === String(clashMiniProxyState.groupName || '').trim();
}

function updateLatencyProgressEntry(payload, bestName) {
  const entryName = String(payload.name || '').trim();
  const index = entryName
    ? clashMiniProxyState.proxies.findIndex((item) => item.name === entryName)
    : Number(payload.index);
  const current = clashMiniProxyState.proxies[index];
  if (!current) return;
  clashMiniProxyState.proxies[index] = normalizeProxyEntry({ ...payload, name: current.name }, bestName, '超时');
}

function selectLatencyProgressBest(bestName) {
  clashMiniProxyState.current = bestName;
  clashMiniProxyState.proxies = clashMiniProxyState.proxies.map((item) => ({
    ...item, selected: String(item?.name || '').trim() === bestName,
  }));
}

// 获取/读取/解析：loadVpnNodeSelectorOptions的具体业务逻辑。
async function loadVpnNodeSelectorOptions({ force = false, probeDelays = true } = {}) {
  if (typeof window.aiFree?.network?.getClashProxyOptions !== 'function') return null;
  if (!force && !isVpnEnabled) return null;
  if (vpnNodeSelectorBusy) return null;
  if (vpnNodeOptionsLoadPromise) return vpnNodeOptionsLoadPromise;

  const task = fetchVpnNodeSelectorOptions(probeDelays);
  vpnNodeOptionsLoadPromise = task;
  try {
    return await task;
  } finally {
    if (vpnNodeOptionsLoadPromise === task) vpnNodeOptionsLoadPromise = null;
  }
}

async function fetchVpnNodeSelectorOptions(probeDelays) {
  try {
    // 先读取组和历史延时并立即渲染，不能让节点列表等待整批测速结束。
    const result = await window.aiFree.network.getClashProxyOptions({ includeDelays: false });
    if (!result || result.ok !== true) {
      clashMiniProxyState = emptyClashMiniProxyState(result);
      syncVpnNodeSelectorState();
      scheduleVpnNodeSelectorRender({ forceFull: true });
      return result;
    }

    clashMiniProxyState = buildClashMiniProxyState(result, false, clashMiniProxyState.proxies);

    syncVpnNodeSelectorState();
    scheduleVpnNodeSelectorRender({ forceFull: true });
    if (probeDelays === true) void probeUnmeasuredVpnNodes(result.proxies);
    return result;
  } catch (error) {
    console.warn('[侧边栏] 获取节点列表失败:', error?.message || error);
    return null;
  }
}

async function probeUnmeasuredVpnNodes(proxies) {
  const names = (Array.isArray(proxies) ? proxies : [])
    .filter((item) => !(Number.isFinite(Number(item?.delay)) && Number(item.delay) > 0))
    .map((item) => String(item?.name || '').trim())
    .filter(Boolean);
  if (names.length > 0) await retestVpnNodes(names);
}

function emptyClashMiniProxyState(result) {
  return { groupName: String(result?.groupName || '节点选择').trim() || '节点选择', current: '', names: [], proxies: [] };
}

function buildClashMiniProxyState(result, probeDelays, previousProxies) {
  const current = String(result.current || '').trim();
  return {
    groupName: String(result.groupName || '节点选择').trim() || '节点选择',
    current,
    names: resolveProxyResultNames(result),
    proxies: probeDelays
      ? (Array.isArray(result.proxies) ? result.proxies : [])
      : mergeProxyEntriesWithPrevious(result.proxies, previousProxies, current),
  };
}

function resolveProxyResultNames(result) {
  if (Array.isArray(result.names) && result.names.length) return result.names;
  if (!Array.isArray(result.proxies)) return [];
  return Array.from(new Set(result.proxies.map((item) => String(item?.name || '').trim()).filter(Boolean)));
}

// 供外部模块（connection-sync 等）在批量启停按钮后调用，收敛选路按钮状态。
function syncLatencyButtonState() {
  if (!testLatencyBtn) return;
  applyVpnActionAvailability();
  syncVpnNodeSelectorState();
}

// 设置/更新/持久化：applyClashMiniStatus的具体业务逻辑。
function applyClashMiniStatus(status, { loadProxyOptions = true } = {}) {
  try {
    const wasRunning = isVpnEnabled === true;
    clashCoreRunning = status?.running === true;
    const enabled = clashCoreRunning && status.enabled === true;
    isVpnEnabled = enabled;
    syncLatencyButtonState();
    syncVpnNodeSelectorState();
    if (typeof syncLoggedOutProtectedEntryAvailability === 'function') {
      syncLoggedOutProtectedEntryAvailability();
    }
    handleClashStatusTransition(wasRunning, enabled, loadProxyOptions);
  } catch (_) {}
}

function handleClashStatusTransition(wasRunning, enabled, loadProxyOptions) {
  if (enabled && !wasRunning && loadProxyOptions) {
    loadVpnNodeSelectorOptions({ force: true, probeDelays: true }).catch(() => {});
    return;
  }
  if (enabled || !wasRunning) return;
  clashMiniProxyState = { ...clashMiniProxyState, current: '', names: [], proxies: [] };
  syncVpnNodeSelectorState();
  scheduleVpnNodeSelectorRender({ forceFull: true });
}

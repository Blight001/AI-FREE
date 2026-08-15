// 创建/初始化：createTabElement的具体业务逻辑。
async function restartTabRuntime(tabElement, runtimeBadge, compatibilityMode = false) {
  if (typeof ShellApi.restartBrowserRuntime !== 'function' || runtimeBadge.disabled) return;
  runtimeBadge.disabled = true;
  runtimeBadge.textContent = '…';
  try {
    const result = await ShellApi.restartBrowserRuntime({
      profileId: tabElement.dataset.id,
      compatibilityMode,
    });
    if (!result?.ok) throw new Error(result?.message || '重启失败');
  } catch (error) {
    showControllerError('重启 AI-FREE 环境失败', error);
    runtimeBadge.disabled = false;
    runtimeBadge.textContent = '重启';
  }
}

function createRuntimeRecoveryButton(tabElement) {
  const runtimeBadge = document.createElement('button');
  runtimeBadge.type = 'button';
  runtimeBadge.className = 'tab-runtime-badge crashed';
  runtimeBadge.textContent = '重启';
  runtimeBadge.title = 'AI-FREE 浏览器已退出，点击重新启动';
  runtimeBadge.addEventListener('click', (event) => {
    event.stopPropagation();
    void restartTabRuntime(tabElement, runtimeBadge);
  });
  return runtimeBadge;
}

function createRuntimeRecoveryControls(tabElement) {
  const controls = document.createElement('span');
  controls.className = 'tab-runtime-actions';
  controls.appendChild(createRuntimeRecoveryButton(tabElement));
  const compatible = document.createElement('button');
  compatible.type = 'button';
  compatible.className = 'tab-runtime-badge crashed';
  compatible.textContent = '兼容';
  compatible.title = '使用无 GPU 兼容模式重试';
  compatible.addEventListener('click', (event) => {
    event.stopPropagation();
    void restartTabRuntime(tabElement, compatible, true);
  });
  controls.appendChild(compatible);
  const diagnostics = document.createElement('button');
  diagnostics.type = 'button';
  diagnostics.className = 'tab-runtime-badge crashed';
  diagnostics.textContent = '诊断';
  diagnostics.title = '打开脱敏诊断目录';
  diagnostics.addEventListener('click', (event) => {
    event.stopPropagation();
    void ShellApi.openBrowserDiagnostics?.();
  });
  controls.appendChild(diagnostics);
  return controls;
}

function initializeTabElement(tab) {
  const element = document.createElement('div');
  element.className = 'tab';
  if (tab.isActive) element.classList.add('active');
  element.dataset.id = tab.id;
  element.draggable = true;
  element.title = buildTabTooltip(tab);
  element.dataset.runtimeType = String(tab?.runtimeType || 'chromium');
  element.dataset.runtimeStatus = String(tab?.runtimeStatus || 'ready');
  element.dataset.browserHistoryId = String(tab?.browserHistoryId || '');
  element.classList.toggle('network-magic', tab?.networkMagicEnabled === true);
  return element;
}

function syncTabSiteIcon(iconElement, iconUrl, fallbackUrl = '') {
  if (!iconElement) return;
  const image = iconElement.querySelector('img');
  const nextUrl = String(iconUrl || '').trim();
  const nextFallback = String(fallbackUrl || '').trim();
  if (!image || (image.dataset.iconUrl === nextUrl && image.dataset.fallbackUrl === nextFallback)) return;
  image.dataset.iconUrl = nextUrl;
  image.dataset.fallbackUrl = nextFallback;
  image.dataset.fallbackAttempted = '0';
  iconElement.classList.remove('has-site-icon');
  image.removeAttribute('src');
  if (nextUrl) image.src = nextUrl;
}

function createTabSiteIcon(tab) {
  const icon = document.createElement('span');
  icon.className = 'tab-site-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"></circle><path d="M3.8 12h16.4M12 3.5c2.2 2.3 3.3 5.1 3.3 8.5S14.2 18.2 12 20.5C9.8 18.2 8.7 15.4 8.7 12S9.8 5.8 12 3.5Z"></path></svg>';
  const image = document.createElement('img');
  image.alt = '';
  image.referrerPolicy = 'no-referrer';
  image.addEventListener('load', () => icon.classList.add('has-site-icon'));
  image.addEventListener('error', () => {
    const fallbackUrl = String(image.dataset.fallbackUrl || '');
    if (fallbackUrl && fallbackUrl !== image.src && image.dataset.fallbackAttempted !== '1') {
      image.dataset.fallbackAttempted = '1';
      image.src = fallbackUrl;
      return;
    }
    icon.classList.remove('has-site-icon');
  });
  icon.appendChild(image);
  syncTabSiteIcon(icon, tab?.iconUrl, tab?.iconFallbackUrl);
  return icon;
}

function appendTabContent(tabElement, tab) {
  tabElement.appendChild(createTabSiteIcon(tab));
  const titleSpan = document.createElement('span');
  titleSpan.className = 'tab-title';
  titleSpan.textContent = tab.title;
  titleSpan.title = buildTabTooltip(tab);
  tabElement.appendChild(titleSpan);
  if (tab?.runtimeType === 'chromium' && tab?.runtimeStatus === 'crashed') {
    tabElement.appendChild(createRuntimeRecoveryControls(tabElement));
  }
  const closeBtn = document.createElement('span');
  closeBtn.className = 'tab-close';
  closeBtn.textContent = 'x';
  closeBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    ShellApi.closeTab(tab.id);
  });
  closeBtn.addEventListener('auxclick', (event) => event.stopPropagation());
  tabElement.appendChild(closeBtn);
}

function bindTabPointerEvents(tabElement, tab) {
  tabElement.addEventListener('click', () => ShellApi.switchTab(tab.id));
  tabElement.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    beginTabRename(tabElement);
  });
  tabElement.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void showTabContextMenu(tab, event);
  });
  tabElement.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    ShellApi.closeTab(tab.id);
  });
}

function bindTabDragEvents(tabElement, tab) {
  tabElement.addEventListener('dragstart', (event) => startTabDrag(event, tabElement, tab.id));
  tabElement.addEventListener('dragend', finishTabDrag);
  tabElement.addEventListener('dragover', (event) => updateTabDragOver(event, tabElement, tab.id));
  tabElement.addEventListener('dragleave', () => leaveTabDrag(tabElement, tab.id));
  tabElement.addEventListener('drop', (event) => dropTab(event, tabElement, tab.id));
}

function startTabDrag(event, tabElement, tabId) {
  draggedTabId = tabId;
  tabElement.classList.add('dragging');
  try {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', tabId);
  } catch (_) {}
}

function finishTabDrag() {
  draggedTabId = null;
  clearDragIndicators();
}

function updateTabDragOver(event, tabElement, tabId) {
  if (!draggedTabId || draggedTabId === tabId) return;
  event.preventDefault();
  try { event.dataTransfer.dropEffect = 'move'; } catch (_) {}
  const position = getDropPosition(event, tabElement);
  if (dragHoverTabId !== tabId || dragHoverPosition !== position) updateDragHoverState(tabElement, position);
}

function leaveTabDrag(tabElement, tabId) {
  if (dragHoverTabId !== tabId) return;
  tabElement.classList.remove('drop-before', 'drop-after');
  dragHoverTabId = null;
  dragHoverPosition = null;
}

function dropTab(event, tabElement, tabId) {
  event.preventDefault();
  const sourceTabId = draggedTabId || event.dataTransfer?.getData('text/plain');
  if (!sourceTabId || sourceTabId === tabId) return clearDragIndicators();
  const position = getDropPosition(event, tabElement);
  ShellApi.reorderTab({ tabId: sourceTabId, targetTabId: tabId, position });
  clearDragIndicators();
}

function createTabElement(tab) {
  const tabElement = initializeTabElement(tab);
  appendTabContent(tabElement, tab);
  bindTabPointerEvents(tabElement, tab);
  bindTabDragEvents(tabElement, tab);
  return tabElement;
}

// 同步/连接：syncTabElement的具体业务逻辑。
function syncTabElement(tabElement, tab) {
  syncTabSiteIcon(tabElement.querySelector('.tab-site-icon'), tab.iconUrl, tab.iconFallbackUrl);
  const titleSpan = tabElement.querySelector('.tab-title');
  if (titleSpan) {
    if (titleSpan.textContent !== tab.title) {
      titleSpan.textContent = tab.title;
    }
    titleSpan.title = buildTabTooltip(tab);
  }
  tabElement.title = buildTabTooltip(tab);
  tabElement.dataset.browserHistoryId = String(tab?.browserHistoryId || '');
  tabElement.dataset.runtimeStatus = String(tab?.runtimeStatus || 'starting');
  tabElement.classList.toggle('network-magic', tab?.networkMagicEnabled === true);
  const runtimeBadge = tabElement.querySelector('.tab-runtime-actions');
  const crashed = tab?.runtimeType === 'chromium' && tab?.runtimeStatus === 'crashed';
  if (runtimeBadge && !crashed) {
    runtimeBadge.remove();
  } else if (!runtimeBadge && crashed) {
    const recoveryButton = createRuntimeRecoveryControls(tabElement);
    tabElement.insertBefore(recoveryButton, tabElement.querySelector('.tab-close'));
  }
  tabElement.classList.toggle('active', !!tab.isActive);
}

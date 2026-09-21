// 底部浏览器任务栏控制（渲染进程）
// 所有主窗口操作均通过 preload 暴露的具名 window.aiFree 能力完成。

function handleNewBrowserPointerDown(event) {
    if (event.button !== 0 || newBrowserWindowBtn.disabled || independentBrowserCreationPending) return;
    browserHistoryGestureState.pointerId = event.pointerId;
    browserHistoryGestureState.startX = event.clientX;
    browserHistoryGestureState.startY = event.clientY;
    browserHistoryGestureState.lastX = event.clientX;
    browserHistoryGestureState.lastY = event.clientY;
    browserHistoryGestureState.active = false;
    browserHistoryGestureState.selectedId = '';
    browserHistoryGestureState.history = null;
    browserHistoryGestureState.loading = true;
    browserHistoryGestureState.loadToken += 1;
    newBrowserWindowBtn.classList.add('gesture-armed');
    try { newBrowserWindowBtn.setPointerCapture(event.pointerId); } catch (_) {}
}

function handleNewBrowserPointerMove(event) {
    if (event.pointerId !== browserHistoryGestureState.pointerId) return;
    browserHistoryGestureState.lastX = event.clientX;
    browserHistoryGestureState.lastY = event.clientY;
    if (!browserHistoryGestureState.active) {
      const deltaX = event.clientX - browserHistoryGestureState.startX;
      const deltaY = event.clientY - browserHistoryGestureState.startY;
      if (deltaY <= -BROWSER_HISTORY_GESTURE_THRESHOLD && Math.abs(deltaY) > Math.abs(deltaX)) {
        event.preventDefault();
        showBrowserHistoryGesturePopup();
        void loadBrowserHistoryForGesture(browserHistoryGestureState.loadToken);
      }
    }
    if (browserHistoryGestureState.active) {
      event.preventDefault();
      updateBrowserHistoryGestureSelection(event.clientX, event.clientY);
    }
}

function handleNewBrowserPointerUp(event) {
    if (event.pointerId !== browserHistoryGestureState.pointerId) return;
    const wasActive = browserHistoryGestureState.active;
    if (wasActive) updateBrowserHistoryGestureSelection(event.clientX, event.clientY);
    const selectedId = wasActive ? browserHistoryGestureState.selectedId : '';
    if (wasActive) event.preventDefault();
    finishBrowserHistoryPointer({ suppressClick: wasActive });
    if (selectedId) void openBrowserHistoryFromGesture(selectedId);
}

function handleNewBrowserPointerCancel(event) {
    if (event.pointerId !== browserHistoryGestureState.pointerId) return;
    finishBrowserHistoryPointer({ suppressClick: browserHistoryGestureState.active });
}

async function createIndependentBrowserFromShell() {
    if (independentBrowserCreationPending) return;
    let acceptedForBackgroundCreation = false;
    setIndependentBrowserCreationPending(true);
    try {
      const response = await ShellApi.createIndependentBrowser( { name: '新建窗口' });
      if (!response?.ok) throw new Error(response?.error || '新建浏览器窗口失败');
      acceptedForBackgroundCreation = response.pending === true;
      pendingBrowserCreationTabId = String(response.tabId || '').trim();
      pendingRenameTabId = String(response.tabId || '');
      const tabElement = tabElementById.get(pendingRenameTabId);
      if (tabElement) {
        beginTabRename(tabElement, { commitOnBlur: true });
        pendingRenameTabId = null;
      }
    } catch (error) {
      showControllerError('新建浏览器窗口失败', error);
    } finally {
      if (!acceptedForBackgroundCreation) {
        pendingBrowserCreationTabId = null;
        setIndependentBrowserCreationPending(false);
      }
    }
}

function handleNewBrowserClick(event) {
    event.preventDefault();
    event.stopPropagation();
    if (suppressNewBrowserWindowClick || newBrowserWindowBtn.disabled) return;
    void createIndependentBrowserFromShell();
}

window.AppShellBrowserActions = Object.freeze({
  createIndependentBrowser: createIndependentBrowserFromShell,
});

function bindNewBrowserWindowBtnOnce() {
  newBrowserWindowBtn = document.getElementById('new-browser-window-btn');
  if (!newBrowserWindowBtn || newBrowserWindowBtn.dataset.bound === '1') return;
  newBrowserWindowBtn.title = '新建浏览器；按住向上拖动可选择浏览器历史';
  newBrowserWindowBtn.setAttribute('aria-label', '新建浏览器；按住向上拖动可选择浏览器历史');
  newBrowserWindowBtn.addEventListener('pointerdown', handleNewBrowserPointerDown);
  newBrowserWindowBtn.addEventListener('pointermove', handleNewBrowserPointerMove);
  newBrowserWindowBtn.addEventListener('pointerup', handleNewBrowserPointerUp);
  newBrowserWindowBtn.addEventListener('pointercancel', handleNewBrowserPointerCancel);
  newBrowserWindowBtn.addEventListener('lostpointercapture', handleNewBrowserPointerCancel);
  newBrowserWindowBtn.addEventListener('click', handleNewBrowserClick);
  newBrowserWindowBtn.dataset.bound = '1';
}

function bindHomeTabBtnOnce() {
  const homeTabBtn = document.getElementById('home-tab-btn');
  if (!homeTabBtn || homeTabBtn.dataset.bound === '1') return;
  homeTabBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    ShellApi.switchTab(null);
  });
  homeTabBtn.dataset.bound = '1';
}

// 同步/连接：bindAddTabBtnOnce的具体业务逻辑。
function bindAddTabBtnOnce() {
  addTabBtn = document.getElementById('add-tab-btn');
  if (!addTabBtn) return;
  if (addTabBtn.dataset.bound === '1') return;
  addTabBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (toggleSidebarClickLock) return;
    toggleSidebarClickLock = true;
    rememberSidebarToggleSource('account-center');
    UiApi.openAccountCenterSidebar?.();
    setTimeout(() => { toggleSidebarClickLock = false; }, 300);
  });
  addTabBtn.dataset.bound = '1';
}

onReady(() => {
  tabsContainer = document.getElementById('tabs-container');
  window.AppShellHome?.bind();
  bindHomeTabBtnOnce();
  bindAddTabBtnOnce();
  bindThemeToggleBtnOnce();
  bindNewBrowserWindowBtnOnce();
  void syncBrowserEmptyStateSidebarWidth();
  void syncAppShellVersion();

  // 初始化设置按钮动画监听器
  initSettingsBtnAnimation();
});

let lastSidebarToggleSource = 'account-center';

function rememberSidebarToggleSource(source) {
  lastSidebarToggleSource = source === 'ai-control' ? 'ai-control' : 'account-center';
}

function resolveSidebarToggleButton() {
  if (lastSidebarToggleSource === 'ai-control') {
    return document.getElementById('shell-ai-control-btn') || document.getElementById('add-tab-btn');
  }
  return document.getElementById('add-tab-btn');
}

function playSidebarToggleAnimation(kind) {
  const collapsing = kind === 'collapsing';
  const button = resolveSidebarToggleButton();
  document.querySelectorAll('#add-tab-btn, #shell-ai-control-btn').forEach((element) => {
    element.classList.remove('collapsing', 'expanding');
  });
  if (!button) return;
  button.classList.add(collapsing ? 'collapsing' : 'expanding');
  setTimeout(() => {
    button.classList.remove(collapsing ? 'collapsing' : 'expanding');
  }, collapsing ? 400 : 150);
}

function initSettingsBtnAnimation() {
  const addTabBtn = document.getElementById('add-tab-btn');
  const aiControlBtn = document.getElementById('shell-ai-control-btn');
  if (!addTabBtn && !aiControlBtn) return;

  aiControlBtn?.addEventListener('click', () => rememberSidebarToggleSource('ai-control'), true);

  UiApi.onSidebarCollapse(() => {
    setBrowserEmptyStateSidebarVisible(false);
    playSidebarToggleAnimation('collapsing');
  });

  UiApi.onSidebarExpand(() => {
    setBrowserEmptyStateSidebarVisible(true);
    playSidebarToggleAnimation('expanding');
  });

  UiApi.onSidebarWidthChanged?.(setBrowserEmptyStateSidebarWidth);
}
function removeStaleTabElements(nextTabIdSet) {
  for (const [tabId, element] of tabElementById.entries()) {
    if (nextTabIdSet.has(tabId)) continue;
    try { element.remove(); } catch (_) {}
    tabElementById.delete(tabId);
  }
}

function readCurrentTabOrder() {
  const currentOrder = [];
  for (const child of tabsContainer.children) {
    if (child.classList?.contains('tab')) currentOrder.push(String(child.dataset.id || ''));
  }
  return currentOrder;
}

function renderReorderedTabs(tabs) {
  const fragment = document.createDocumentFragment();
  tabs.forEach((tab) => {
    const tabId = String(tab.id);
    let tabElement = tabElementById.get(tabId);
    if (!tabElement) {
      tabElement = createTabElement(tab);
      tabElementById.set(tabId, tabElement);
    } else {
      syncTabElement(tabElement, tab);
    }
    fragment.appendChild(tabElement);
  });
  if (newBrowserWindowBtn?.parentNode === tabsContainer) {
    tabsContainer.insertBefore(fragment, newBrowserWindowBtn);
  } else {
    if (newBrowserWindowBtn) fragment.appendChild(newBrowserWindowBtn);
    tabsContainer.replaceChildren(fragment);
  }
}

function reconcileTabElements(tabs) {
  const nextTabIds = tabs.map((tab) => String(tab.id));
  const nextTabIdSet = new Set(nextTabIds);
  removeStaleTabElements(nextTabIdSet);
  const currentOrder = readCurrentTabOrder();
  const orderUnchanged = currentOrder.length === nextTabIds.length
    && currentOrder.every((id, index) => id === nextTabIds[index])
    && nextTabIds.every((id) => tabElementById.has(id));

  if (orderUnchanged) {
    tabs.forEach((tab) => {
      const tabElement = tabElementById.get(String(tab.id));
      if (tabElement) syncTabElement(tabElement, tab);
    });
  } else {
    renderReorderedTabs(tabs);
  }
}

function finishPendingTabRename() {
  if (pendingRenameTabId) {
    const pendingTabElement = tabElementById.get(String(pendingRenameTabId));
    if (pendingTabElement) {
      beginTabRename(pendingTabElement, { commitOnBlur: true });
      pendingRenameTabId = null;
    }
  }
}

// 从主进程接收标签数据
BrowserApi.onTabsUpdated( (tabs) => {
  setBrowserEmptyStateVisible(tabs);
  if (!tabsContainer) tabsContainer = document.getElementById('tabs-container');
  if (!tabsContainer) return;
  reconcileTabElements(tabs);
  finishPendingTabRename();

  applyAdaptiveTabSizing();
  console.log(`标签页已更新: 总数=${tabs.length}, 自适应宽度已应用`);
});

window.addEventListener('resize', () => {
  if (browserHistoryGestureState.pointerId !== null) {
    finishBrowserHistoryPointer({ suppressClick: browserHistoryGestureState.active });
  }
  applyAdaptiveTabSizing();
});
window.addEventListener('blur', () => {
  if (browserHistoryGestureState.pointerId !== null) {
    finishBrowserHistoryPointer({ suppressClick: browserHistoryGestureState.active });
  }
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && browserHistoryGestureState.pointerId !== null) {
    event.preventDefault();
    finishBrowserHistoryPointer({ suppressClick: browserHistoryGestureState.active });
  }
});

// 事件绑定统一通过 bindAddTabBtnOnce，并带幂等保护，避免重复绑定导致抖动

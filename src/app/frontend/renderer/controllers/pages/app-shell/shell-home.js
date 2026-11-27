(() => {
  let focusPersonalOnShow = false;
  let syncConsole;
  let syncMcp;
  let modelSettings;

  function setVisible(tabs = []) {
    const home = document.getElementById('browser-empty-state');
    if (!home) return;
    const activeTab = Array.isArray(tabs) ? tabs.find((tab) => tab?.isActive) : null;
    const status = String(activeTab?.runtimeStatus || '').trim().toLowerCase();
    const wasVisible = !home.hidden;
    home.hidden = status === 'ready' || status === 'hidden';
    if (home.hidden && wasVisible) {
      leaveAccounts();
      clearPersonalTransientState();
    } else if (focusPersonalOnShow) focusPersonal();
    modelSettings?.sync();
    syncConsole?.();
    syncMcp?.();
  }

  function leaveAccounts() {
    document.getElementById('provider-category-menu')?.hidePopover();
  }

  function clearPersonalTransientState() {
    closeAccountProfileMenu();
    clearSidebarAuthPasswords();
  }

  function leavePersonal() {
    setAnnouncementMailOpen(false);
    clearPersonalTransientState();
    vipPlansOpenRequested = false;
    focusPersonalOnShow = false;
  }

  function focusPersonal() {
    if (document.getElementById('browser-empty-state').hidden) return;
    focusPersonalOnShow = false;
    const vip = document.getElementById('vip-benefits-dialog');
    if (vipPlansOpenRequested && isSidebarAccountAuthenticated()) openVipBenefitsDialog();
    const target = vip.open ? vip.querySelector('.vip-benefits-close')
      : document.getElementById(isSidebarAccountAuthenticated() ? 'home-personal' : 'sidebar-auth-username');
    target?.focus();
  }

  function openPersonal() {
    document.getElementById('home-personal-tab').click();
    focusPersonalOnShow = true;
    focusPersonal();
  }

  function tabIndexFromKey(key, current, count) {
    switch (key) {
      case 'ArrowUp': return (current - 1 + count) % count;
      case 'ArrowDown': return (current + 1) % count;
      case 'Home': return 0;
      case 'End': return count - 1;
      default: return -1;
    }
  }

  function bindHomeTabs() {
    const tabLists = [...document.querySelectorAll('.shell-home-tabs, .shell-home-personal-tabs')];
    const tabs = tabLists.flatMap((tabList) => [
      ...tabList.querySelectorAll('[role="tab"]:not([hidden])'),
    ]);
    if (!tabs.length) return;
    const panels = tabs.map((tab) => document.getElementById(tab.getAttribute('aria-controls')));
    const select = (selectedTab) => {
      const selected = tabs.indexOf(selectedTab);
      if (selected < 0) return;
      if (panels[selected].id !== 'home-personal' && !document.getElementById('home-personal').hidden) leavePersonal();
      if (panels[selected].id !== 'home-accounts') leaveAccounts();
      if (selectedTab.getAttribute('aria-selected') !== 'true') homeDialogs.reset();
      tabs.forEach((tab, index) => {
        const active = index === selected;
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
        panels[index].hidden = !active;
      });
      syncConsole?.();
      syncMcp?.();
      modelSettings?.sync();
    };
    tabLists.forEach((tabList) => {
      tabList.addEventListener('click', (event) => {
        const tab = event.target.closest('[role="tab"]');
        if (tab && tabList.contains(tab)) select(tab);
      });
      tabList.addEventListener('keydown', (event) => {
        const listTabs = [...tabList.querySelectorAll('[role="tab"]:not([hidden])')];
        const current = listTabs.indexOf(event.target.closest('[role="tab"]'));
        if (current < 0) return;
        const next = tabIndexFromKey(event.key, current, listTabs.length);
        if (next < 0) return;
        event.preventDefault();
        select(listTabs[next]);
        listTabs[next].focus();
      });
    });
  }

  function bind() {
    if (new URLSearchParams(location.search).get('dev') === '1' && window.aiFree?.diagnostics) {
      document.getElementById('home-console-tab').hidden = false;
      syncConsole = bindHomeConsole();
      document.getElementById('home-mcp-tab').hidden = false;
      syncMcp = bindHomeMcp();
    }
    bindSiteData();
    bindHomeTabs();
    modelSettings = bindHomeModels();
    window.aiFree?.ui?.onOpenHomeModelSettings?.(modelSettings.open);
    window.AppShellAutomation?.bind();
    window.AppShellSkills?.bind();
  }

  window.AppShellHome = Object.freeze({ bind, setVisible, openPersonal });
})();

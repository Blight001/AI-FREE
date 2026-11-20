(() => {
  let focusPersonalOnShow = false;

  function setVisible(tabs = []) {
    const home = document.getElementById('browser-empty-state');
    if (!home) return;
    const activeTab = Array.isArray(tabs) ? tabs.find((tab) => tab?.isActive) : null;
    const status = String(activeTab?.runtimeStatus || '').trim().toLowerCase();
    const wasVisible = !home.hidden;
    home.hidden = status === 'ready' || status === 'hidden';
    if (home.hidden && wasVisible) leavePersonal();
    else if (focusPersonalOnShow) focusPersonal();
  }

  function leavePersonal() {
    closeVipBenefitsDialog();
    closeAccountProfileMenu();
    vipPlansOpenRequested = false;
    clearSidebarAuthPasswords();
    focusPersonalOnShow = false;
  }

  function focusPersonal() {
    if (document.getElementById('browser-empty-state').hidden) return;
    focusPersonalOnShow = false;
    const vip = document.getElementById('vip-benefits-dialog');
    const target = !vip.hidden ? vip.querySelector('.vip-benefits-close')
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
    const tabList = document.querySelector('.shell-home-tabs');
    if (!tabList) return;
    const tabs = [...tabList.querySelectorAll('[role="tab"]')];
    const panels = tabs.map((tab) => document.getElementById(tab.getAttribute('aria-controls')));
    const select = (selected) => {
      if (panels[selected].id !== 'home-personal' && !document.getElementById('home-personal').hidden) leavePersonal();
      tabs.forEach((tab, index) => {
        const active = index === selected;
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
        panels[index].hidden = !active;
      });
    };
    tabList.addEventListener('click', (event) => {
      const index = tabs.indexOf(event.target.closest('[role="tab"]'));
      if (index !== -1) select(index);
    });
    tabList.addEventListener('keydown', (event) => {
      const current = tabs.indexOf(event.target);
      if (current === -1) return;
      const next = tabIndexFromKey(event.key, current, tabs.length);
      if (next === -1) return;
      event.preventDefault();
      select(next);
      tabs[next].focus();
    });
  }

  function bind() {
    bindHomeTabs();
    const button = document.getElementById('browser-settings-dev-console');
    button?.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await window.aiFree.diagnostics.openConsole();
        if (!result?.ok) throw new Error(result?.error?.message || '调试控制台打开失败');
      } catch (error) {
        window.MessageModal?.showErrorMessage?.(error.message);
      } finally { button.disabled = false; }
    });
  }

  window.AppShellHome = Object.freeze({ bind, setVisible, openPersonal });
})();

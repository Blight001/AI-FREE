(() => {
  function setVisible(tabs = []) {
    const home = document.getElementById('browser-empty-state');
    if (!home) return;
    const activeTab = Array.isArray(tabs) ? tabs.find((tab) => tab?.isActive) : null;
    const status = String(activeTab?.runtimeStatus || '').trim().toLowerCase();
    home.hidden = status === 'ready' || status === 'hidden';
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
    const select = (selected) => tabs.forEach((tab, index) => {
      const active = index === selected;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      panels[index].hidden = !active;
    });
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
    document.getElementById('home-open-account-center')?.addEventListener('click', () => {
      rememberSidebarToggleSource('account-center');
      window.aiFree?.ui?.openAccountCenterSidebar?.();
    });
    const aiButton = document.getElementById('shell-ai-control-btn');
    aiButton?.addEventListener('click', async () => {
      aiButton.disabled = true;
      try {
        rememberSidebarToggleSource?.('ai-control');
        window.aiFree?.ui?.openAiControlSidebar?.();
      } catch (error) {
        window.MessageModal?.showErrorMessage?.(error?.message || String(error));
      } finally { aiButton.disabled = false; }
    });
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

  window.AppShellHome = Object.freeze({ bind, setVisible });
})();

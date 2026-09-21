(() => {
  function setVisible(tabs = []) {
    const home = document.getElementById('browser-empty-state');
    if (!home) return;
    const activeTab = Array.isArray(tabs) ? tabs.find((tab) => tab?.isActive) : null;
    const status = String(activeTab?.runtimeStatus || '').trim().toLowerCase();
    home.hidden = status === 'ready' || status === 'hidden';
  }

  function bind() {
    const aiButton = document.getElementById('shell-ai-control-btn');
    aiButton?.addEventListener('click', async () => {
      aiButton.disabled = true;
      try {
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

(() => {
  const params = new URLSearchParams(location.search);
  const explicitMode = params.get('dev');
  if (explicitMode === '1' || explicitMode === '0') {
    try { sessionStorage.setItem('ai-free.sidebar.dev-mode', explicitMode); } catch (_) {}
  }
  let enabled = explicitMode === '1';
  if (explicitMode !== '0' && explicitMode !== '1') {
    try { enabled = sessionStorage.getItem('ai-free.sidebar.dev-mode') === '1'; } catch (_) {}
  }
  document.documentElement.classList.toggle('development-mode', enabled);
  document.querySelectorAll('[data-dev-only]').forEach((item) => { item.hidden = !enabled; });
  document.querySelectorAll('[data-open-ai-control]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        window.aiFree?.ui?.openAiControlSidebar?.();
      } catch (error) {
        window.MessageModal?.showErrorMessage?.(error?.message || String(error));
      } finally { button.disabled = false; }
    });
  });
  document.querySelectorAll('[data-open-account-center]').forEach((button) => {
    button.addEventListener('click', () => window.aiFree?.ui?.openAccountCenterSidebar?.());
  });
})();

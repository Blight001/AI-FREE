document.addEventListener('DOMContentLoaded', () => {
  window.MessageModal.initServerMessageListener();
  initAnnouncementListener();
  bindHomeAccountRuntime();
  bindSidebarAccountAuth();
  bindLicenseValidationControls();
  bindServerAccountCookieListener();
  bindTutorialLink();
  bindRuntimeValueListeners();
  loadInitialConnectionState();
  loadInitialRuntimeValues();
  document.getElementById('browser-settings-create-browser')?.addEventListener('click', () => {
    void window.AppShellBrowserActions.createIndependentBrowser();
  });
});

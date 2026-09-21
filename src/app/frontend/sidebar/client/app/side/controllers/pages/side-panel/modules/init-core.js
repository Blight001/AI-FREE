let sidePanelCoreInitialized = false;

// 创建/初始化：initSidePanelCore的具体业务逻辑。
function initSidePanelCore() {
  if (sidePanelCoreInitialized) {
    return;
  }
  sidePanelCoreInitialized = true;

  if (window.MessageModal && typeof window.MessageModal.initServerMessageListener === 'function') {
    window.MessageModal.initServerMessageListener();
  }

  const isDevMode = document.documentElement.classList.contains('development-mode');

  if (!isDevMode) {
    document.querySelectorAll('.debug-only').forEach((button) => {
      button.style.display = 'none';
    });
  }
}

// Only the homepage content becomes inert. The app taskbar stays in the focus order.
const homeDialogs = (() => {
  const layer = document.getElementById('home-dialog-layer');
  const home = document.getElementById('browser-empty-state');
  const content = document.getElementById('ai-free-settings-panel');
  const confirmation = document.getElementById('home-confirm-dialog');
  const stack = [];
  let browserDataClearConfirmationBound = false;

  function release(dialog, restoreFocus) {
    const { resolveFocus, previousFocus, onClose } = stack.pop();
    const underlying = stack.at(-1)?.dialog;
    if (underlying) underlying.inert = false;
    else {
      layer.hidden = true;
      content.inert = false;
    }
    if (restoreFocus && !home.hidden) {
      const target = resolveFocus?.() || previousFocus;
      if (target?.isConnected && target.getClientRects().length) target.focus();
      else content.querySelector('[role="tab"][aria-selected="true"]')?.focus();
    }
    onClose?.(dialog.returnValue);
  }

  function open(dialog, { focus, resolveFocus, onClose } = {}) {
    if (home.hidden || !layer.contains(dialog) || dialog.open) return false;
    if (document.getElementById(dialog.dataset.homePanel)?.hidden) return false;
    const underlying = stack.at(-1)?.dialog;
    if (underlying && dialog !== confirmation) return false;
    stack.push({ dialog, previousFocus: document.activeElement, resolveFocus, onClose });
    if (underlying) underlying.inert = true;
    layer.hidden = false;
    content.inert = true;
    dialog.returnValue = '';
    dialog.show();
    focus?.focus();
    return true;
  }

  function close(dialog, restoreFocus = true) {
    if (!dialog || stack.at(-1)?.dialog !== dialog) return;
    dialog.close();
    release(dialog, restoreFocus);
  }

  function reset() {
    while (stack.length) close(stack.at(-1).dialog, false);
  }

  function dismiss(dialog) {
    if (dialog?.open && dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) close(dialog);
  }

  layer.addEventListener('submit', (event) => {
    if (event.defaultPrevented || event.target.method !== 'dialog') return;
    const dialog = event.target.closest('dialog');
    event.preventDefault();
    dialog.returnValue = event.submitter?.value || '';
    close(dialog);
  });
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.key !== 'Escape' || home.hidden || !stack.length) return;
    if (document.getElementById('server-message-modal')?.style.display === 'flex') return;
    event.preventDefault();
    dismiss(stack.at(-1).dialog);
  });

  function confirm(message) {
    return new Promise((resolve) => {
      if (confirmation.open) return resolve(false);
      document.getElementById('home-confirm-message').textContent = message;
      if (!open(confirmation, { onClose: (value) => resolve(value === 'confirm') })) resolve(false);
    });
  }

  function bindBrowserDataClearConfirmation() {
    const browser = window.aiFree?.browser;
    if (typeof browser?.onDataClearConfirmRequested !== 'function' || browserDataClearConfirmationBound) return;
    browserDataClearConfirmationBound = true;
    browser.onDataClearConfirmRequested((payload = {}) => {
      const requestId = String(payload?.requestId || '').trim();
      if (!requestId) return;
      const browserTitle = String(payload?.title || '当前浏览器').trim() || '当前浏览器';
      const message = `确认清空"${browserTitle}"的浏览器数据?\n\nCookie、缓存、浏览历史、本地存储和页面会话将被删除，浏览器会自动重新打开。窗口配置和已下载文件会保留。`;
      void confirm(message).then(async (confirmed) => {
        try {
          const result = await browser.resolveDataClearConfirm({ requestId, confirmed });
          if (confirmed && !result?.ok) window.MessageModal?.showErrorMessage(result?.message || '清空浏览器数据失败');
          else if (confirmed) window.MessageModal?.showSuccessMessage('浏览器数据已清空');
        } catch (error) {
          if (confirmed) window.MessageModal?.showErrorMessage(error?.message || '清空浏览器数据失败');
        }
      });
    });
  }

  bindBrowserDataClearConfirmation();
  return Object.freeze({ open, close, reset, confirm });
})();

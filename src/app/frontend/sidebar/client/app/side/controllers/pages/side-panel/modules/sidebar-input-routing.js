function initSidebarAnimationListener() {
  if (typeof window.aiFree?.ui?.onDeviceIdUpdated !== 'function') return;

  window.aiFree.ui.onSidebarCollapse(() => {
    document.body.classList.add('collapsing');
    document.body.classList.remove('expanding');
    setTimeout(() => {
      document.body.classList.remove('collapsing');
    }, 400);
  });

  window.aiFree.ui.onSidebarExpand(() => {
    document.body.classList.add('expanding');
    document.body.classList.remove('collapsing');
    setTimeout(() => {
      document.body.classList.remove('expanding');
    }, 200);
  });
}

let sidebarInputFocusPending = false;
let sidebarInputFocusLastRequestedAt = 0;

// Windows sends WM_MOUSEWHEEL to the native window that owns the input queue.
// The independently embedded Chromium HWND can keep that ownership even while
// the pointer is already over the Electron sidebar. Repair it as soon as the
// sidebar receives pointer movement instead of waiting for a wheel event that
// will never reach this renderer.
function requestSidebarInputFocus(force = false, textInput = false) {
  if (sidebarInputFocusPending || typeof window.aiFree?.ui?.focusSidebarInput !== 'function') return;
  if (document.documentElement.dataset.aiInputComposing === 'true' && !textInput) return;
  const now = Date.now();
  if (!force && now - sidebarInputFocusLastRequestedAt < 120) return;
  sidebarInputFocusLastRequestedAt = now;
  sidebarInputFocusPending = true;
  const focusRequest = {
    interaction: force ? 'explicit' : 'passive',
  };
  if (textInput) focusRequest.interaction = 'text-input';
  void window.aiFree.ui.focusSidebarInput(focusRequest)
    .catch(() => {})
    .finally(() => {
      sidebarInputFocusPending = false;
    });
}

function initSidebarInputRouting() {
  // document.hasFocus() and WebContents.isFocused() can both remain true after
  // the separately hosted Chromium HWND receives native SetFocus. Pointer entry
  // and real sidebar clicks therefore reclaim input without consulting either
  // cached focus flag. The move listener remains a cheap fallback for Windows
  // wheel routing after a native focus transition.
  document.addEventListener('pointerenter', () => requestSidebarInputFocus(), true);
  document.addEventListener('pointerdown', (event) => {
    const textInput = event.target?.matches?.('input, textarea, [contenteditable="true"]') === true;
    if (textInput) requestSidebarInputFocus(true, true);
    else requestSidebarInputFocus(true);
  }, true);
  document.addEventListener('focusin', (event) => {
    if (event.target?.matches?.('input, textarea, select, [contenteditable="true"]')) {
      const textInput = event.target?.matches?.('input, textarea, [contenteditable="true"]') === true;
      requestSidebarInputFocus(true, textInput);
    }
  }, true);
  document.addEventListener('pointermove', () => {
    if (!document.hasFocus()) requestSidebarInputFocus();
  }, { passive: true });
}

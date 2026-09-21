(function initNetworkMagicSidebar() {
  const dialog = document.getElementById('network-magic-sidebar-dialog');
  const openRequested = new URLSearchParams(window.location.search).get('openNetworkMagic') === '1';
  if (!dialog) {
    window.aiFree?.ui?.onNetworkMagicPanelToggle?.((payload) => {
      if (payload?.open === true) window.location.assign('./ai-control.html?openNetworkMagic=1');
    });
    return;
  }

  const setOpen = (open) => {
    const nextOpen = open === true;
    if (!nextOpen) window.setVpnNodeSelectorOpen?.(false);
    dialog.hidden = !nextOpen;
    document.documentElement.classList.toggle('network-magic-dialog-open', nextOpen);
  };

  window.aiFree?.ui?.onNetworkMagicPanelToggle?.((payload) => setOpen(payload?.open === true));
  dialog.querySelectorAll('[data-network-magic-close]').forEach((button) => {
    button.addEventListener('click', () => {
      setOpen(false);
      window.aiFree?.shell?.toggleNetworkMagicPanel?.({ open: false });
    });
  });
  dialog.querySelectorAll('[data-vpn-node-selector-close]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      window.setVpnNodeSelectorOpen?.(false);
    });
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !dialog.hidden) {
      if (document.getElementById('vpn-node-selector-panel')?.hidden === false) {
        window.setVpnNodeSelectorOpen?.(false);
      } else {
        setOpen(false);
        window.aiFree?.shell?.toggleNetworkMagicPanel?.({ open: false });
      }
    }
  });
  dialog.dataset.bound = '1';
  if (openRequested) setOpen(true);
})();

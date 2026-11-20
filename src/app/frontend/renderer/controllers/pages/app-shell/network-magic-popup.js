function bindNetworkMagicPopupPage() {
  if (!document.documentElement.classList.contains('network-magic-popup-page')) return;
  window.MessageModal.initServerMessageListener();
  bindClashMiniControls();
  const originalSetNodeOpen = window.setVpnNodeSelectorOpen;
  window.setVpnNodeSelectorOpen = (open) => {
    originalSetNodeOpen?.(open);
    window.aiFree?.shell?.toggleNetworkMagicPanel?.({
      open: true,
      expanded: open === true,
    });
  };
  document.querySelectorAll('[data-network-magic-close]').forEach((button) => {
    button.addEventListener('click', () => {
      window.aiFree?.shell?.toggleNetworkMagicPanel?.({ open: false });
    });
  });
  document.querySelectorAll('[data-vpn-node-selector-close]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      window.setVpnNodeSelectorOpen?.(false);
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (document.getElementById('vpn-node-selector-panel')?.hidden === false) {
      window.setVpnNodeSelectorOpen?.(false);
      return;
    }
    window.aiFree?.shell?.toggleNetworkMagicPanel?.({ open: false });
  });
  window.aiFree?.ui?.onAppThemeChanged?.((theme) => {
    const nextTheme = String(theme || '').trim();
    document.documentElement.classList.toggle('theme-light', nextTheme !== 'dark' && nextTheme !== 'gold');
    document.documentElement.classList.toggle('theme-gold', nextTheme === 'gold');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindNetworkMagicPopupPage);
} else {
  bindNetworkMagicPopupPage();
}

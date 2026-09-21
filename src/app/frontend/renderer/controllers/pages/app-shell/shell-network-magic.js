function setNetworkMagicMenuOpen(open) {
  const menu = document.getElementById('shell-network-magic-menu');
  const toggle = document.getElementById('shell-network-magic-toggle');
  if (!menu || !toggle) return;
  const nextOpen = open === true;
  menu.hidden = !nextOpen;
  toggle.classList.toggle('is-open', nextOpen);
  toggle.setAttribute('aria-expanded', String(nextOpen));
}

function closeVpnNodeSelectorDialog() {
  if (typeof setVpnNodeSelectorOpen === 'function') setVpnNodeSelectorOpen(false);
}

function bindNetworkMagicMenuToggle(toggle, menu) {
  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setNetworkMagicMenuOpen(menu.hidden);
  });
}

function bindNetworkMagicMenuDismiss(root, menu) {
  document.addEventListener('click', (event) => {
    if (menu.hidden) return;
    if (root.contains(event.target)) return;
    setNetworkMagicMenuOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    setNetworkMagicMenuOpen(false);
    closeVpnNodeSelectorDialog();
  });
}

function bindNetworkMagicNodeDialog() {
  document.getElementById('vpn-node-selector-toggle-btn')?.addEventListener('click', () => {
    setNetworkMagicMenuOpen(false);
  });
  document.querySelectorAll('[data-vpn-node-selector-close]').forEach((button) => {
    button.addEventListener('click', () => closeVpnNodeSelectorDialog());
  });
}

function bindNetworkMagicShell() {
  const root = document.getElementById('shell-network-magic');
  const toggle = document.getElementById('shell-network-magic-toggle');
  const menu = document.getElementById('shell-network-magic-menu');
  if (!root || !toggle || !menu || toggle.dataset.bound === '1') return;
  bindNetworkMagicMenuToggle(toggle, menu);
  bindNetworkMagicMenuDismiss(root, menu);
  bindNetworkMagicNodeDialog();
  toggle.dataset.bound = '1';
}

function syncNetworkMagicLauncherState(enabled) {
  const toggle = document.getElementById('shell-network-magic-toggle');
  if (!toggle) return;
  const isEnabled = enabled === true;
  toggle.classList.toggle('is-active', isEnabled);
  toggle.title = isEnabled ? '内置代理已开启' : '内置代理';
  toggle.setAttribute('aria-label', toggle.title);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindNetworkMagicShell);
} else {
  bindNetworkMagicShell();
}

function bindNetworkMagicShell() {
  const root = document.getElementById('shell-network-magic');
  const toggle = document.getElementById('shell-network-magic-toggle');
  if (!root || !toggle || toggle.dataset.bound === '1') return;
  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    window.aiFree?.shell?.toggleNetworkMagicPanel?.({
      anchor: readNetworkMagicButtonAnchor(toggle),
    });
  });
  window.aiFree?.ui?.onNetworkMagicPanelToggle?.((payload) => {
    setNetworkMagicLauncherOpen(payload?.open === true);
  });
  window.aiFree?.network?.onClashStatus?.((status) => {
    syncNetworkMagicLauncherState(status?.running === true && status.enabled === true);
  });
  toggle.dataset.bound = '1';
}

function readNetworkMagicButtonAnchor(toggle) {
  const rect = toggle?.getBoundingClientRect?.();
  if (!rect) return null;
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
  };
}

function setNetworkMagicLauncherOpen(open) {
  const toggle = document.getElementById('shell-network-magic-toggle');
  if (!toggle) return;
  toggle.classList.toggle('is-open', open === true);
  toggle.setAttribute('aria-expanded', String(open === true));
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

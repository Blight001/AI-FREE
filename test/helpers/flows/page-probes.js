'use strict';

// These probes preserve the existing packaged page assertions. They only read;
// navigation, window lifecycle and scene expectations belong to other layers.
function aiPage() {
  const logos = Array.from(document.querySelectorAll('img[data-app-logo]'));
  return { logoCount: logos.length,
    logosLoaded: logos.every((image) => image instanceof HTMLImageElement
      && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) };
}

function shellPage() {
  const ids = ['update-widget', 'shell-app-version', 'theme-toggle-btn', 'shell-network-magic',
    'shell-ai-control-btn'];
  const controls = ids.map((id) => document.getElementById(id));
  const action = (id, text) => {
    const button = document.getElementById(id);
    return button?.tagName === 'BUTTON' && button.textContent.trim() === text
      && !!button.querySelector('.shell-action-icon');
  };
  const create = document.getElementById('new-browser-window-btn');
  return {
    avatarRemoved: !document.getElementById('account-center-btn'),
    controlsOrdered: controls.slice(0, -1).every((control, index) => control?.nextElementSibling === controls[index + 1]),
    homeButtonFirst: document.getElementById('tab-bar')?.firstElementChild?.id === 'home-tab-btn',
    personalCenterInHome: !document.getElementById('add-tab-btn')
      && !!document.querySelector('#home-personal #sidebar-account-auth')
      && !!document.querySelector('#browser-empty-state #vip-benefits-dialog'),
    networkMagicButton: action('shell-network-magic-toggle', '内置代理'),
    aiControlButton: action('shell-ai-control-btn', 'AI 控制'),
    matchingActionIcons: ['shell-ai-control-btn', 'shell-network-magic-toggle']
      .every((id) => !!document.getElementById(id)?.querySelector('.shell-action-icon')),
    modernCreateIcon: !!create?.querySelector('svg.new-window-icon') && create.textContent.trim() === '',
    taskbarAtBottom: document.getElementById('tab-bar')?.getBoundingClientRect().bottom === window.innerHeight,
  };
}

const pageProbes = Object.freeze({ ai: aiPage, shell: shellPage });
module.exports = { pageProbes };

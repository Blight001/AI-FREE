'use strict';

function bindAccountSettingsDialog() {
  const dialog = document.getElementById('account-general-settings');
  const button = document.getElementById('account-settings-btn');
  const closeButton = dialog?.querySelector('[data-account-settings-close]');
  if (!dialog || !button || !closeButton || button.dataset.bound === 'true') return;
  button.dataset.bound = 'true';

  const sync = () => button.setAttribute('aria-expanded', String(dialog.open));
  const close = () => homeDialogs.close(dialog);

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    document.getElementById('home-personal-tab')?.click();
    if (homeDialogs.open(dialog, {
      focus: closeButton,
      onClose: sync,
    })) {
      if (typeof setAnnouncementMailOpen === 'function') setAnnouncementMailOpen(false);
      sync();
    }
  });
  closeButton.addEventListener('click', close);
  sync();
}

document.addEventListener('DOMContentLoaded', () => {
  bindAccountSettingsDialog();
  const wraps = Array.from(document.querySelectorAll('.account-pref-hint-wrap'));
  if (!wraps.length) return;

  const setOpen = (wrap, open) => {
    wrap.classList.toggle('is-open', open);
    wrap.querySelector('.account-pref-hint')?.setAttribute('aria-expanded', String(open));
  };

  wraps.forEach((wrap) => {
    const button = wrap.querySelector('.account-pref-hint');
    if (!button) return;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const shouldOpen = !wrap.classList.contains('is-open');
      wraps.forEach((item) => setOpen(item, item === wrap && shouldOpen));
    });
  });

  document.addEventListener('click', (event) => {
    wraps.forEach((wrap) => {
      if (!wrap.contains(event.target)) setOpen(wrap, false);
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    wraps.forEach((wrap) => setOpen(wrap, false));
  });
});

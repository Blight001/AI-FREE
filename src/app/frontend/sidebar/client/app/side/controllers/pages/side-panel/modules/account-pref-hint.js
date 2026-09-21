'use strict';

function bindAccountSettingsPopover() {
  const details = document.getElementById('account-general-settings');
  const button = document.getElementById('account-settings-btn');
  if (!details || !button || button.dataset.bound === 'true') return;
  button.dataset.bound = 'true';

  const sync = () => {
    button.setAttribute('aria-expanded', String(details.open === true));
    if (details.open === true && typeof setAnnouncementMailOpen === 'function') {
      setAnnouncementMailOpen(false);
    }
  };

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    details.open = !details.open;
  });
  details.addEventListener('toggle', sync);
  document.addEventListener('click', (event) => {
    if (details.open !== true) return;
    if (event.target?.closest?.('#account-general-settings, #account-settings-btn')) return;
    details.open = false;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') details.open = false;
  });
  sync();
}

document.addEventListener('DOMContentLoaded', () => {
  bindAccountSettingsPopover();
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

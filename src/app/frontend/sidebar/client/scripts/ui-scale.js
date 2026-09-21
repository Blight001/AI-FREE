'use strict';

(function initializeUiScale() {
  const STORAGE_KEY = 'ai-free.ui.scale';
  const MIN = 1;
  const MAX = 1.2;
  const DEFAULT = 1.1;
  const STEP = 0.05;

  function normalize(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT;
    const stepped = Math.round(numeric / STEP) * STEP;
    return Math.min(MAX, Math.max(MIN, Number(stepped.toFixed(2))));
  }

  function read() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved === null ? DEFAULT : normalize(saved);
    } catch (_) { return DEFAULT; }
  }

  function notifyMain(scale) {
    try { window.aiFree?.ui?.setUiScale?.({ scale }); } catch (_) {}
  }

  function apply(value, { persist = false, notify = false } = {}) {
    const scale = normalize(value);
    document.documentElement.style.setProperty('--ui-scale', String(scale));
    document.documentElement.dataset.uiScale = String(scale);
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, String(scale)); } catch (_) {}
    }
    if (notify) notifyMain(scale);
    window.dispatchEvent(new CustomEvent('ai-free-ui-scale-changed', { detail: { scale } }));
    return scale;
  }

  window.AiFreeUiScale = Object.freeze({
    max: MAX,
    min: MIN,
    default: DEFAULT,
    normalize,
    read,
    apply,
    step: STEP,
  });

  apply(read(), { notify: true });
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) apply(event.newValue);
  });
})();

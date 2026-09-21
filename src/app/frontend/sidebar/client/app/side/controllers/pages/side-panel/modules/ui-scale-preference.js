'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('ui-scale');
  const status = document.getElementById('ui-scale-status');
  const api = window.AiFreeUiScale;
  if (!input || !api) return;

  const render = (scale) => {
    const percent = Math.round(scale * 100);
    input.value = String(percent);
    const label = percent <= 100 ? '小' : percent >= 120 ? '大' : '中等';
    input.setAttribute('aria-valuetext', label);
  };

  const setStatus = (message, state = '') => {
    if (!status) return;
    status.textContent = message;
    status.dataset.state = state;
  };

  render(api.read());
  input.addEventListener('input', () => {
    const scale = api.normalize(Number(input.value) / 100);
    api.apply(scale, { persist: true, notify: true });
    render(scale);
    setStatus('已保存', 'success');
  });
  window.addEventListener('ai-free-ui-scale-changed', (event) => {
    if (event.detail?.scale !== undefined) render(api.normalize(event.detail.scale));
  });
});

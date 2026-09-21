'use strict';

function normalizeStartupState(data = {}) {
  return {
    openAtLogin: data.openAtLogin === true,
    startMinimized: data.startMinimized === true,
    supported: data.supported !== false,
  };
}

function resultError(result, fallback) {
  return result?.error?.message || result?.error || fallback;
}

function setStartupStatus(status, message, state = '') {
  if (!status) return;
  status.textContent = message;
  status.dataset.state = state;
}

async function loadStartupPreference(api, input, status) {
  try {
    const result = await api?.getStartupSettings?.();
    if (!result?.ok) throw new Error(resultError(result, '读取开机启动设置失败'));
    const state = normalizeStartupState(result.data);
    input.checked = state.openAtLogin;
    input.disabled = !state.supported;
    setStartupStatus(status, state.supported ? '' : '当前系统不支持开机自启');
    return state;
  } catch (error) {
    input.checked = false;
    setStartupStatus(status, error?.message || '读取开机启动设置失败', 'error');
    return normalizeStartupState();
  }
}

async function saveStartupPreference(api, enabled, persisted, input, status) {
  input.disabled = true;
  setStartupStatus(status, '保存中…');
  try {
    const result = await api?.setStartupSettings?.({ enabled });
    if (!result?.ok) throw new Error(resultError(result, '保存开机启动设置失败'));
    const next = normalizeStartupState(result.data);
    input.checked = next.openAtLogin;
    setStartupStatus(status, '已保存', 'success');
    return next;
  } catch (error) {
    input.checked = persisted.openAtLogin;
    setStartupStatus(status, error?.message || '保存开机启动设置失败', 'error');
    return persisted;
  } finally {
    input.disabled = !persisted.supported;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('app-startup-enabled');
  const status = document.getElementById('app-startup-status');
  const api = window.aiFree?.ui;
  if (!input) return;
  let persisted = normalizeStartupState();
  input.addEventListener('change', async () => {
    persisted = await saveStartupPreference(api, input.checked, persisted, input, status);
  });
  void loadStartupPreference(api, input, status).then((state) => { persisted = state; });
});

'use strict';

(function bindExternalCodexPreferenceModule() {
  function setCodexStatus(status, message, state = '') {
    if (!status || typeof status !== 'object') return;
    status.textContent = message;
    status.dataset.state = state;
    status.dataset.type = state === 'success' ? 'success' : (state === 'error' ? 'error' : 'info');
  }

  function renderExternalStatus(status, data = {}) {
    const codexStatus = data.codex?.message || '';
    if (data.membershipRequired) {
      setCodexStatus(status, data.codex?.linked ? 'Codex 已连接，等待账号授权' : '已启动，等待账号授权');
    } else if (data.ready) {
      setCodexStatus(status, `已就绪 · ${data.toolCount || 0} 个工具`, 'success');
    } else setCodexStatus(status, codexStatus || '已启动，等待浏览器连接');
  }

  async function loadExternalCodexStatus(api, status) {
    try {
      const result = await api?.getExternalCodexStatus?.();
      if (!result?.ok) throw new Error(result?.error || '外部 Codex 桥接不可用');
      renderExternalStatus(status, result.data || {});
    } catch (error) {
      setCodexStatus(status, error?.message || '外部 Codex 桥接不可用', 'error');
    }
  }

  async function copyExternalCodexConfig(api, button, status) {
    button.disabled = true;
    setCodexStatus(status, '复制中…');
    try {
      const result = await api?.copyExternalCodexConfig?.();
      if (!result?.ok) throw new Error(result?.error || '复制连接配置失败');
      setCodexStatus(status, '配置已复制到剪贴板', 'success');
    } catch (error) {
      setCodexStatus(status, error?.message || '复制连接配置失败', 'error');
    } finally {
      button.disabled = false;
    }
  }

  function bindExternalCodexPreference() {
    const status = document.getElementById('external-codex-status');
    const copyButton = document.getElementById('copy-external-codex-config');
    if (!status || !copyButton) return;
    const api = window.aiFree?.ui;
    copyButton.addEventListener('click', () => void copyExternalCodexConfig(api, copyButton, status));
    window.refreshExternalCodexPreference = () => void loadExternalCodexStatus(api, status);
    void loadExternalCodexStatus(api, status);
  }

  document.addEventListener('DOMContentLoaded', bindExternalCodexPreference);
}());

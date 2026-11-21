'use strict';

let serverDeviceBusy = false;
let mcpCopyPending = false;

function integrationElement(id) { return document.getElementById(id); }

function integrationError(error, fallback = '') {
  return String(error?.error || error?.message || fallback || error || '');
}

function setIntegrationStatus(element, message, type = 'info') {
  if (!element) return;
  element.textContent = message;
  element.dataset.type = type;
}

function renderServerDeviceSummary(status) {
  const summary = integrationElement('ai-server-device-summary');
  if (!summary) return;
  summary.hidden = !status.serviceId;
  summary.textContent = status.serviceId
    ? `设备 ${status.serviceId} · MCP ${Number(status.toolCount || 0)} 个${status.aiConfigId == null ? '' : ` · AI #${status.aiConfigId}`}${status.remembered ? ' · 已启用自动连接' : ''}`
    : '';
}

function initializeServerDeviceFields(status) {
  const server = integrationElement('ai-server-device-server');
  const account = integrationElement('ai-server-device-account');
  const serviceName = integrationElement('ai-server-device-name');
  if (server && status.server) server.value = String(status.server);
  if (account && status.account && !account.value) account.value = String(status.account);
  if (serviceName && status.serviceName) serviceName.value = String(status.serviceName);
}

function renderServerDeviceStatus(status = {}) {
  setIntegrationStatus(integrationElement('ai-server-device-status'),
    String(status.message || '尚未连接 AI 服务器'),
    status.phase === 'registered' ? 'success' : status.phase === 'error' ? 'error' : 'info');
  renderServerDeviceSummary(status);
  const logout = integrationElement('ai-server-device-logout');
  if (logout) logout.hidden = !status.connected && !status.registered && !status.remembered;
}

let serverDeviceFieldsLoaded = false;

async function loadServerDeviceStatus() {
  try {
    const result = await window.aiFree?.ai?.getServerDeviceStatus?.();
    if (!result?.ok) throw new Error(integrationError(result, '读取设备状态失败'));
    const status = result.status || {};
    if (!serverDeviceFieldsLoaded) {
      initializeServerDeviceFields(status);
      serverDeviceFieldsLoaded = true;
    }
    if (!serverDeviceBusy) renderServerDeviceStatus(status);
  } catch (error) {
    setIntegrationStatus(integrationElement('ai-server-device-status'), integrationError(error), 'error');
  }
}

function serverDevicePayload() {
  return {
    server: String(integrationElement('ai-server-device-server')?.value || '').trim(),
    account: String(integrationElement('ai-server-device-account')?.value || '').trim(),
    password: String(integrationElement('ai-server-device-password')?.value || ''),
    serviceName: String(integrationElement('ai-server-device-name')?.value || '').trim(),
  };
}

function setServerDeviceBusy(busy) {
  serverDeviceBusy = busy === true;
  integrationElement('ai-server-device-form')?.querySelectorAll('input, button').forEach((control) => {
    control.disabled = serverDeviceBusy;
  });
  const login = integrationElement('ai-server-device-login');
  if (login) login.textContent = serverDeviceBusy ? '连接中…' : '登录并连接';
}

async function loginServerDevice(event) {
  event.preventDefault();
  if (serverDeviceBusy) return;
  setServerDeviceBusy(true);
  try {
    const payload = serverDevicePayload();
    integrationElement('ai-server-device-password').value = '';
    const result = await window.aiFree.ai.loginServerDevice(payload);
    renderServerDeviceStatus(result?.status || {});
    if (!result?.ok) throw new Error(integrationError(result, '登录 AI 服务器失败'));
    if (result.warning) {
      setIntegrationStatus(integrationElement('ai-server-device-status'), `连接成功，但${result.warning}`, 'info');
    }
  } catch (error) {
    setIntegrationStatus(integrationElement('ai-server-device-status'), integrationError(error), 'error');
  } finally {
    setServerDeviceBusy(false);
  }
}

async function logoutServerDevice() {
  if (serverDeviceBusy) return;
  setServerDeviceBusy(true);
  try {
    const result = await window.aiFree.ai.logoutServerDevice();
    if (!result?.ok) throw new Error(integrationError(result, '断开连接失败'));
    renderServerDeviceStatus(result.status || {});
  } catch (error) {
    setIntegrationStatus(integrationElement('ai-server-device-status'), integrationError(error), 'error');
  } finally {
    setServerDeviceBusy(false);
  }
}

function renderHomeMcpStatus(button, { published, membershipRequired, ready, toolCount }) {
  const status = integrationElement('external-mcp-status');
  if (!published) setIntegrationStatus(status, '尚未启动');
  else if (membershipRequired) setIntegrationStatus(status, '等待 VIP 授权');
  else if (!ready) setIntegrationStatus(status, '尚未就绪');
  else {
    setIntegrationStatus(status, `已就绪 · ${toolCount || 0} 个工具`, 'success');
    button.disabled = false;
  }
}

async function refreshHomeMcpStatus() {
  const button = integrationElement('copy-external-mcp-config');
  if (!button || mcpCopyPending) return;
  button.disabled = true;
  setIntegrationStatus(integrationElement('external-mcp-status'), '检查中…');
  try {
    const result = await window.aiFree.ui.getExternalCodexStatus();
    if (!result?.ok) throw new Error(result?.error || '本机 MCP 服务不可用');
    renderHomeMcpStatus(button, result.data);
  } catch (error) {
    setIntegrationStatus(integrationElement('external-mcp-status'), error?.message || '本机 MCP 服务不可用', 'error');
  }
}

async function copyHomeMcpConfig(button) {
  mcpCopyPending = true;
  button.disabled = true;
  setIntegrationStatus(integrationElement('external-mcp-status'), '复制中…');
  try {
    const result = await window.aiFree?.ui?.copyExternalCodexConfig?.();
    if (!result?.ok) throw new Error(result?.error || '复制 MCP 配置失败');
    setIntegrationStatus(integrationElement('external-mcp-status'), '配置已复制到剪贴板', 'success');
  } catch (error) {
    setIntegrationStatus(integrationElement('external-mcp-status'), error?.message || '复制 MCP 配置失败', 'error');
  } finally {
    mcpCopyPending = false;
    button.disabled = false;
  }
}

function bindHomeModelIntegrations() {
  integrationElement('ai-server-device-form')?.addEventListener('submit', (event) => void loginServerDevice(event));
  integrationElement('ai-server-device-logout')?.addEventListener('click', () => void logoutServerDevice());
  integrationElement('copy-external-mcp-config')?.addEventListener('click', (event) => {
    void copyHomeMcpConfig(event.currentTarget);
  });
  window.aiFree?.ai?.onServerDeviceStatus?.(renderServerDeviceStatus);
  return (section) => {
    if (section !== 'server') integrationElement('ai-server-device-password').value = '';
    if (section === 'server') void loadServerDeviceStatus();
    if (section === 'mcp') void refreshHomeMcpStatus();
  };
}

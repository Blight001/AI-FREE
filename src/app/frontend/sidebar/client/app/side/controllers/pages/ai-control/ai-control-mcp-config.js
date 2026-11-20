'use strict';

let externalMcpCopyPending = false;

function setExternalMcpStatus(message, type = 'info') {
  const status = document.getElementById('external-mcp-status');
  status.textContent = message;
  status.dataset.type = type;
}

async function refreshExternalMcpStatus() {
  const button = document.getElementById('copy-external-mcp-config');
  if (externalMcpCopyPending) return;
  button.disabled = true;
  setExternalMcpStatus('检查中…');
  try {
    const result = await window.aiFree?.ui?.getExternalCodexStatus();
    if (!result?.ok) throw new Error(result?.error || '本机 MCP 服务不可用');
    const { published, membershipRequired, ready, toolCount } = result.data;
    if (!published) setExternalMcpStatus('尚未启动');
    else if (membershipRequired) setExternalMcpStatus('等待 VIP 授权');
    else if (!ready) setExternalMcpStatus('尚未就绪');
    else {
      setExternalMcpStatus(`已就绪 · ${toolCount || 0} 个工具`, 'success');
      button.disabled = false;
    }
  } catch (error) {
    setExternalMcpStatus(error?.message || '本机 MCP 服务不可用', 'error');
  }
}

async function copyExternalMcpConfig(button) {
  externalMcpCopyPending = true;
  button.disabled = true;
  setExternalMcpStatus('复制中…');
  try {
    const result = await window.aiFree?.ui?.copyExternalCodexConfig();
    if (!result?.ok) throw new Error(result?.error || '复制 MCP 配置失败');
    setExternalMcpStatus('配置已复制到剪贴板', 'success');
  } catch (error) {
    setExternalMcpStatus(error?.message || '复制 MCP 配置失败', 'error');
  } finally {
    externalMcpCopyPending = false;
    button.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const button = document.getElementById('copy-external-mcp-config');
  button.addEventListener('click', () => void copyExternalMcpConfig(button));
});

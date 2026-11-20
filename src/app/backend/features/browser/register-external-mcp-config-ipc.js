'use strict';

function isMcpConfigSender(event, ui) {
  const contents = ui.getSideView?.()?.webContents;
  if (!contents || contents.isDestroyed() || event.sender !== contents) return false;
  const frame = event.senderFrame;
  return frame && frame === contents.mainFrame && frame.url.startsWith('file:///')
    && new URL(frame.url).pathname.endsWith('/frontend/sidebar/ai-control.html');
}

function formatConfig({ endpoint, token }, stdio) {
  return JSON.stringify({
    name: 'ai_free',
    streamableHttp: {
      transport: 'streamable-http',
      url: endpoint,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      messageFormat: 'JSON-RPC 2.0',
      requestSequence: ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'],
    },
    ...(stdio && { stdio: { transport: 'stdio', ...stdio } }),
    notes: [
      '这是通用连接参数，不是特定客户端的配置文件。选择一种传输方式，填入本机 MCP 客户端的对应设置。',
      'AI-FREE 必须保持运行且账号拥有有效的外部 MCP 授权。服务只监听本机；云端执行器不能访问此地址。',
      'HTTP 配置包含密钥，只填入可信客户端的连接设置，不要发到聊天、日志或共享文件。重启 AI-FREE 或授权变化后，遇到 401 请重新复制。',
      ...(stdio ? ['仅支持 stdio 或不支持自定义请求头的本机客户端可使用 stdio 参数；该适配器自动读取当前密钥。'] : []),
    ],
  }, null, 2);
}

function copyExternalMcpConfig(event, ctx, writeText) {
  if (!isMcpConfigSender(event, ctx.ui)) return { ok: false, error: '请在 AI 控制侧栏复制 MCP 配置' };
  const bridge = ctx.browserAutomationBridge;
  const status = bridge?.getExternalMcpStatus?.();
  if (!status?.published) return { ok: false, error: '本机 MCP 服务尚未启动' };
  if (status.membershipRequired) return { ok: false, error: '请先登录并完成 VIP 授权' };
  const connection = bridge.getExternalMcpConnectionInfo();
  if (!status.ready || !connection?.endpoint || !connection.token) {
    return { ok: false, error: '本机 MCP 服务尚未就绪' };
  }
  try {
    writeText(formatConfig(connection, ctx.externalCodexLink?.getStdioConnection?.()));
    return { ok: true, data: { mode: 'streamable-http' } };
  } catch (_) {
    return { ok: false, error: '无法写入剪贴板，请重试' };
  }
}

function registerExternalMcpConfigIpc(ipc, ctx, writeText) {
  // Keep the existing channel names for compatibility with the preload contract.
  ipc.handle('get-external-codex-status', async () => {
    const status = ctx.browserAutomationBridge?.getExternalMcpStatus?.();
    if (!status) return { ok: false, error: '本机 MCP 服务不可用' };
    return { ok: true, data: { ...status, codex: ctx.externalCodexLink?.getStatus?.() || null } };
  });
  ipc.handle('copy-external-codex-config', (event) => copyExternalMcpConfig(event, ctx, writeText));
}

module.exports = { registerExternalMcpConfigIpc };

'use strict';

const { createAiChatService } = require('./ai-chat-service');

function registerAiChatIpc({ ipc, ...deps }) {
  const service = createAiChatService(deps);
  ipc.handle('ai-control-chat-insert', (event, input = {}) => service.insert(event, input));
  ipc.handle('ai-control-chat-stop', (event, input = {}) => service.stop(event, input));
  ipc.handle('ai-control-benchmark-decline', (event, input) => {
    try {
      if (!deps.benchmark) throw new Error('基准测试未启用');
      deps.benchmark.decline(event, input.benchmarkId);
      return { ok: true, data: {} };
    } catch (error) { return { ok: false, error: { code: 'MCP_BENCHMARK_EXPIRED', message: error.message } }; }
  });
  ipc.handle('ai-control-chat', async (event, input = {}) => {
    if (!input.benchmarkId) return service.chat(event, input);
    try {
      if (!deps.benchmark) throw new Error('基准测试未启用');
      return await deps.benchmark.chat(event, input, service);
    } catch (error) { return { ok: false, message: error.message }; }
  });
  return service;
}

module.exports = { registerAiChatIpc };

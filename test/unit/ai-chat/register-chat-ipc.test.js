'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAiChatIpc } = require('../../../src/app/backend/features/ai-chat/register-chat-ipc');

function createIpc() {
  const handlers = new Map();
  return { handlers, handle: (channel, handler) => handlers.set(channel, handler) };
}

test('benchmark-tagged chat is routed to the enabled benchmark controller', async () => {
  const ipc = createIpc();
  const expected = { ok: true, message: { role: 'assistant', content: 'verified' } };
  const benchmark = { chat: async (event, input, service) => {
    assert.equal(event.sender, 'sidebar');
    assert.equal(input.benchmarkId, 'run-1');
    assert.equal(typeof service.chat, 'function');
    return expected;
  } };
  registerAiChatIpc({ ipc, benchmark });

  const result = await ipc.handlers.get('ai-control-chat')(
    { sender: 'sidebar' }, { benchmarkId: 'run-1' },
  );

  assert.equal(result, expected);
});

test('benchmark-tagged chat reports disabled when no controller is wired', async () => {
  const ipc = createIpc();
  registerAiChatIpc({ ipc });

  const result = await ipc.handlers.get('ai-control-chat')(
    { sender: 'sidebar' }, { benchmarkId: 'run-1' },
  );

  assert.deepEqual(result, { ok: false, message: '基准测试未启用' });
});

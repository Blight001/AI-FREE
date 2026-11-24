'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createManagedChatService } = require('../../../src/app/backend/features/ai-chat/managed-chat-service');

function fixture(run) {
  let disk = [];
  const options = {
    repository: { read: () => structuredClone(disk), save: (record) => { disk = [...disk.filter(({ id }) => id !== record.id), structuredClone(record)]; }, delete: (id) => { disk = disk.filter((record) => record.id !== id); } },
    getModels: async () => ({ ok: true, models: [{ id: 'test', name: 'Test' }] }),
    getAccount: () => 'account',
    run,
  };
  return { options, service: createManagedChatService(options) };
}

const caller = { actor: 'local' };

async function create(service) {
  const created = await service.execute(caller, { action: 'create', request_key: 'create-1', model_id: 'test' });
  assert.equal(created.ok, true);
  return created.data.sessionId;
}

test('bounded waits and retries share one child run, including its persisted result', async () => {
  let finish;
  let calls = 0;
  const { service, options } = fixture(async () => {
    calls++;
    return new Promise((resolve) => { finish = resolve; });
  });
  const sessionId = await create(service);
  const send = { action: 'send', session_id: sessionId, request_key: 'send-1', content: 'Draft', wait_ms: 0 };
  const first = await service.execute(caller, send);
  const again = await service.execute(caller, send);
  assert.equal(first.data.runId, again.data.runId);
  assert.equal(calls, 1);
  const conflict = await service.execute(caller, { ...send, content: 'Different' });
  assert.equal(conflict.error.code, 'CHAT_REQUEST_CONFLICT');
  const args = { action: 'wait', run_id: first.data.runId, wait_ms: 500 };
  const waiting = service.execute(caller, args);
  finish({ ok: true, message: { content: 'Result' } });
  const completed = await waiting;
  assert.equal(completed.data.status, 'completed');
  assert.equal(completed.data.result, 'Result');
  const restarted = createManagedChatService(options);
  assert.deepEqual(await restarted.execute(caller, args), completed);
  assert.equal((await restarted.execute({ actor: 'different' }, args)).error.code, 'CHAT_NOT_FOUND');
});

test('pause commits a checkpoint that survives restart and continues on the same run', async () => {
  const { service, options } = fixture(async ({ signal, checkpoint, saveCheckpoint, onQuotaUsed }) => {
    onQuotaUsed(checkpoint ? 0.75 : 0.5);
    if (checkpoint) return { ok: true, message: { content: `Resumed ${checkpoint.round}` } };
    saveCheckpoint({ round: 2, messages: [{ role: 'user', content: 'Draft' }] });
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    return { ok: true, stopped: true, message: { content: '' } };
  });
  const sessionId = await create(service);
  const sent = await service.execute(caller, {
    action: 'send', session_id: sessionId, request_key: 'send-1', content: 'Draft', wait_ms: 0,
  });
  const stopped = await service.execute(caller, { action: 'stop', run_id: sent.data.runId });
  assert.equal(stopped.data.status, 'paused');
  const restarted = createManagedChatService(options);
  const resumed = await restarted.execute(caller, { action: 'resume', run_id: sent.data.runId });
  assert.equal(resumed.data.runId, sent.data.runId);
  assert.equal(resumed.data.result, 'Resumed 2');
  const sidebar = { actor: 'sidebar' };
  const all = await restarted.execute(sidebar, { action: 'list' });
  assert.equal(all.data.sessions[0].quotaUsed, 1.25);
  const detail = await restarted.execute(sidebar, { action: 'status', session_id: sessionId });
  assert.equal(detail.data.quotaUsed, 1.25);
  const external = await restarted.execute(caller, { action: 'status', session_id: sessionId });
  assert.equal(Object.hasOwn(external.data, 'quotaUsed'), false);
});

test('a parent can launch two children before waiting and receives one ordered set of final results', async () => {
  const finish = new Map();
  const { service } = fixture(async ({ record }) => new Promise((resolve) => finish.set(record.content, resolve)));
  const parent = { actor: 'parent:fixture', parentId: 'fixture' };
  const createChild = (request_key) => service.execute(parent, { action: 'create', model_id: 'test', request_key });
  const startChild = (session_id, content) => service.execute(parent, {
    action: 'send', session_id, request_key: 'first-message', content, wait_ms: 0,
  });
  const children = await Promise.all(['first', 'second', 'third'].map(createChild));
  const [first, second] = await Promise.all(children.slice(0, 2).map(({ data }, index) => startChild(data.sessionId, String(index))));
  assert.equal(first.data.status, 'running');
  assert.equal(second.data.status, 'running');
  assert.equal((await startChild(children[2].data.sessionId, '2')).error.code, 'CHAT_CAPACITY');
  let settled = false;
  const waiting = service.execute(parent, { action: 'wait', run_ids: [first.data.runId, second.data.runId], wait_ms: 500 });
  void waiting.then(() => { settled = true; });
  finish.get('1')({ ok: true, message: { content: 'Second result' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  finish.get('0')({ ok: true, message: { content: 'First result' } });
  const { data } = await waiting;
  assert.deepEqual(data.runs.map(({ result }) => result), ['First result', 'Second result']);
});

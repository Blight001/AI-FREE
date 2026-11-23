'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createManagedChatService } = require('../../src/app/backend/features/ai-chat/managed-chat-service');
const { managedToolSet } = require('../../src/app/backend/features/ai-chat/register-managed-chat-ipc');
const { createAiServerDeviceService } = require('../../src/app/backend/features/ai-chat/ai-server-device-service');
const { createAutomationCardMcpRouter } = require('../../src/app/backend/services/automation-card-mcp-router');
const { createBrowserAutomationExternalGateway } = require('../../src/app/backend/services/browser-automation-external-gateway');
const { runChatConversation } = require('../../src/app/backend/features/ai-chat/chat-conversation-runner');

function makeToolEntries({ run }) {
  let persisted = [];
  const service = createManagedChatService({ run, getAccount: () => 'account-a',
    repository: { read: () => persisted, save: (record) => { persisted = [...persisted.filter(({ id }) => id !== record.id), structuredClone(record)]; } },
    getModels: () => ({ ok: true, models: [{ id: 'fixture', name: 'Fixture' }] }),
  });
  const getWindowTools = () => managedToolSet(service);
  const external = createBrowserAutomationExternalGateway({ getWindowTools, getConnections: () => [], getAccess: () => true });
  const card = createAutomationCardMcpRouter({ listConnections: () => [] });
  card.configure({ getWindowTools });
  const parent = managedToolSet(service, 'parent:a', 'a');
  return { service, external, card, parent };
}

const create = (key) => ({ action: 'create', request_key: key, model_id: 'fixture' });
const send = (sessionId) => ({ action: 'send', session_id: sessionId, request_key: 'send', content: 'Fixture' });

test('external disconnect only detaches the wait, child results stay isolated by entry owner', async () => {
  let release;
  let hits = 0;
  const { external, parent, service } = makeToolEntries({ run: async () => {
    hits++;
    return new Promise((resolve) => { release = resolve; });
  } });
  const execute = (args, signal) => external.callTool('chat_session', args, signal);
  const created = await execute(create('create'));
  const sessionId = created.data.sessionId;
  const controller = new AbortController();
  const rpc = execute(send(sessionId), controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const pending = await rpc;
  assert.equal(pending.data.status, 'running');
  const args = { action: 'wait', run_id: pending.data.runId };
  assert.equal((await parent.execute('chat_session', args)).error.code, 'CHAT_NOT_FOUND');
  const reattached = execute(send(sessionId));
  release({ ok: true, message: { content: 'One outcome' } });
  assert.equal((await reattached).data.result, 'One outcome');
  assert.equal(hits, 1);
  assert.equal((await service.execute({ actor: 'sidebar' }, { action: 'status', run_id: args.run_id })).data.result, 'One outcome');
});

test('the card requires a completion and HeySure sends a disconnected task result on re-registration', async () => {
  let release;
  let hits = 0;
  const { card, external } = makeToolEntries({ run: async () => {
    hits++;
    return new Promise((resolve) => { release = resolve; });
  } });
  const opt = { managedChatActor: 'card:fixture' };
  const executeCard = (args) => card.execute('', 'chat_session', args, opt);
  const cardSession = await executeCard(create('card'));
  const pending = await executeCard({ ...send(cardSession.data.sessionId), wait_ms: 0 });
  assert.equal(pending.error.code, 'CHAT_CARD_INCOMPLETE');
  const cardRunId = pending.error.details[0].runId;
  release({ ok: true, message: { content: 'Card result' } });
  assert.equal((await executeCard({ action: 'wait', run_id: cardRunId })).data.result, 'Card result');

  const emitted = [];
  const socket = { connected: true, emit: (event, payload) => emitted.push({ event, payload }) };
  const device = createAiServerDeviceService({ callTool: (...args) => external.callTool(...args) });
  device.socket = socket;
  device.routes.set('aifree.chat+session', 'chat_session');
  const task = (taskId, args) => ({ taskId, args, tool: 'aifree.chat+session' });
  device.handleRegistered();
  await device.handleTask(task('create', create('remote')));
  const remoteSession = emitted[0].payload.result.data.sessionId;
  const remote = device.handleTask(task('send', send(remoteSession)));
  await new Promise((resolve) => setImmediate(resolve));
  socket.connected = false;
  device.handleDisconnect('test connection closed');
  socket.connected = true;
  release({ ok: true, message: { content: 'Remote result' } });
  await remote;
  assert.equal(emitted.length, 1);
  socket.connected = true;
  device.handleRegistered();
  assert.equal(emitted[1].payload.result.data.result, 'Remote result');
  await device.handleTask(task('send', send(remoteSession)));
  assert.deepEqual(emitted[2], emitted[1]);
  assert.equal(hits, 2);
});

test('a restored tool round preserves completed receipts and retries only the pending read-only step', async () => {
  const calls = [];
  const controller = new AbortController();
  const tools = [{ name: 'fixture_read', input_schema: { type: 'object' } }];
  const toolCall = (id) => ({ id, type: 'function', function: { name: 'fixture_read', arguments: JSON.stringify({ id }) } });
  let checkpoint;
  const windowTools = { has: () => true, execute(_name, { id }) {
    calls.push(id);
    if (id === 'second' && !controller.signal.aborted) controller.abort();
    return { success: true, content: id };
  } };
  const model = async (_key, _device, _model, messages) => {
    const receipts = messages.filter(({ role }) => role === 'tool');
    if (!receipts.length) return { ok: true, message: { tool_calls: [toolCall('first'), toolCall('second')] } };
    assert.deepEqual(receipts.map(({ tool_call_id }) => tool_call_id), ['first', 'second']);
    return { ok: true, message: { content: 'Completed safely' } };
  };
  const request = { connections: [], modelId: 'fixture', windowTools, httpClient: { sendAIControlMessage: model },
    emit() {}, saveManagedCheckpoint(value) { checkpoint = value; },
    toolContext: { modelMessages: [{ role: 'user', content: 'Read two records' }], tools },
    run: { controller, insertedMessages: [] },
  };
  const stopped = await runChatConversation(request);
  assert.equal(stopped.stopped, true);
  assert.deepEqual(checkpoint.pending.map(({ id }) => id), ['second']);
  const final = await runChatConversation({ ...request, managedCheckpoint: checkpoint,
    toolContext: { ...request.toolContext, modelMessages: checkpoint.messages },
    run: { controller: new AbortController(), insertedMessages: [] },
  });
  assert.equal(final.message.content, 'Completed safely');
  assert.deepEqual(calls, ['first', 'second', 'second']);
});

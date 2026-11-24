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

const fixtureConnection = { id: 'fixture-browser', name: 'Browser fixture', browserProcessId: 11, connectedAt: 20,
  tools: ['browser_tab', 'browser_action', 'browser_control', 'manage_card', 'chat_session'].map((name) => ({ name,
    input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['overview', 'acquire'] } } } })) };

test('only the parent entry can grant a browser and only one child controls a connection at a time', async () => {
  const { parent, external, card } = makeToolEntries({ run: ({ signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve({ stopped: true }), { once: true });
  }) });
  const target = { browser_connection: fixtureConnection.name, wait_ms: 0 };
  const parentCall = (args) => parent.execute('chat_session', args, {
    browserScope: { connections: [fixtureConnection] },
  });
  const [first, second] = await Promise.all([parentCall(create('first')), parentCall(create('second'))]);
  const externalSession = await external.callTool('chat_session', create('outside'));
  const outside = await external.callTool('chat_session', { ...send(externalSession.data.sessionId), ...target });
  assert.equal(outside.error.code, 'CHAT_BROWSER_FORBIDDEN');
  const cardCall = (args) => card.execute('', 'chat_session', args, { managedChatActor: 'card:fixture' });
  const cardSession = await cardCall(create('card-scope'));
  assert.equal((await cardCall({ ...send(cardSession.data.sessionId), ...target })).error.code, 'CHAT_BROWSER_FORBIDDEN');
  assert.equal((await parentCall({ ...send(first.data.sessionId), ...target, browser_connection: 'unrelated' })).error.code,
    'CHAT_BROWSER_NOT_FOUND');
  const started = await parentCall({ ...send(first.data.sessionId), ...target });
  assert.equal(started.data.status, 'running');
  assert.equal((await parentCall({ ...send(second.data.sessionId), ...target })).error.code, 'CHAT_BROWSER_BUSY');
  const text = await parentCall({ ...send(second.data.sessionId), wait_ms: 0 });
  assert.equal(text.data.status, 'running');
  assert.equal((await parentCall({ action: 'stop', run_id: started.data.runId })).data.status, 'needs_review');
  assert.equal((await parentCall({ action: 'stop', run_id: text.data.runId })).data.status, 'needs_review');
});

test('a delegated browser rejects other connections, global discovery and a restarted instance', async () => {
  const { managedBrowserContext } = require('../../src/app/backend/features/ai-chat/managed-chat-browser');
  const calls = [];
  let connection = fixtureConnection;
  const scope = managedBrowserContext({ getConnection: () => connection, dispatch: (...args) => { calls.push(args); } },
    fixtureConnection);
  assert.deepEqual(scope.connections[0].tools.map(({ name }) => name), ['browser_tab', 'browser_action', 'browser_control']);
  assert.equal(scope.bridge.dispatch('unrelated', 'browser_action', {}).errorCode, 'BROWSER_TARGET_CHANGED');
  assert.equal(scope.bridge.dispatch(connection.id, 'browser_control', { action: 'overview' }).errorCode, 'CHAT_BROWSER_FORBIDDEN');
  scope.bridge.dispatch(connection.id, 'browser_action', { action: 'click' });
  connection = { ...connection, browserProcessId: 12 };
  assert.equal(scope.bridge.dispatch(connection.id, 'browser_action', {}).errorCode, 'BROWSER_TARGET_CHANGED');
  assert.equal(calls.length, 1);
});

test('resuming a delegated browser reports an unconfirmed action and never replays pending writes', async () => {
  const controller = new AbortController();
  const calls = [];
  const toolCall = (id) => ({ id, type: 'function', function: { name: 'browser_action', arguments: JSON.stringify({ id }) } });
  let checkpoint;
  const run = (controller, messages) => runChatConversation({
    connections: [], modelId: 'fixture',
    windowTools: { has: () => true, execute(_name, { id }) {
      calls.push(id);
      if (id === 'second') controller.abort();
      return { success: true, content: id };
    } },
    httpClient: { sendAIControlMessage: async (_key, _device, _model, messages) => {
      const receipts = messages.filter(({ role }) => role === 'tool').map(({ content }) => JSON.parse(content));
      if (!receipts.length) return { ok: true, message: { tool_calls: ['first', 'second', 'third'].map(toolCall) } };
      assert.equal(receipts[0].content, 'first');
      assert.equal(receipts[1].errorCode, 'AI_TOOL_OUTCOME_UNCONFIRMED');
      assert.equal(receipts[2].errorCode, 'AI_TOOL_NOT_STARTED');
      return { ok: true, message: { content: 'Inspect before continuing' } };
    } },
    emit() {}, saveManagedCheckpoint(value) { checkpoint = value; },
    managedCheckpoint: messages ? checkpoint : undefined,
    managedNoReplay: (name) => name === 'browser_action',
    toolContext: { modelMessages: messages || [{ role: 'user', content: 'Execute the fixture workflow' }],
      tools: [{ name: 'browser_action', input_schema: { type: 'object' } }] },
    run: { controller, insertedMessages: [] },
  });
  assert.equal((await run(controller)).stopped, true);
  assert.equal(checkpoint.inFlight, 'second');
  assert.deepEqual(checkpoint.pending.map(({ id }) => id), ['second', 'third']);
  assert.equal((await run(new AbortController(), checkpoint.messages)).message.content, 'Inspect before continuing');
  assert.deepEqual(calls, ['first', 'second']);
});

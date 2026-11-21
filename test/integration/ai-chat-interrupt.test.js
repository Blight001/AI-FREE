const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { postEventStream } = require('../../src/app/backend/lib/http');
const { runChatConversation } = require('../../src/app/backend/features/ai-chat/chat-conversation-runner');

test('a complete model result advances dependent tools before the SSE response ends', async (t) => {
  const order = [];
  const bodies = [];
  const responses = [];
  const closed = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { messages } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const previous = messages.at(-1);
    const round = bodies.push(previous);
    responses.push(response);
    closed.push(once(response, 'close', { signal: AbortSignal.timeout(4000) }));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const message = round === 3 ? { content: 'done' } : { tool_calls: [{ id: `call-${round}`,
      function: { name: 'fixture_read', arguments: JSON.stringify({ value: round === 1 ? 1 : JSON.parse(previous.content).value }) } }] };
    // A malformed result must not end the round; a complete, valid result must.
    response.write('event: result\ndata: {bad json}\n\n');
    response.write(`event: result\ndata: ${JSON.stringify({ ok: true, message })}\n\n`);
    // Do not call end: the client must stop waiting and release the stream.
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const response of responses) response.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}/chat`;
  const result = await runChatConversation({
    useStream: true,
    connections: [],
    emit() {},
    httpClient: { streamAIControlMessage: (_key, _device, _model, messages, _options, onEvent) => (
      postEventStream(url, { messages }, onEvent, 1000)
    ) },
    toolContext: { modelMessages: [{ role: 'user', content: 'read two dependent values' }],
      tools: [{ name: 'fixture_read', input_schema: { type: 'object' } }] },
    windowTools: { has: (name) => name === 'fixture_read', execute: async (_name, { value }) => {
      order.push(value);
      return { success: true, value: value + 1 };
    } },
  });
  assert.equal(result.message.content, 'done');
  assert.deepEqual(order, [1, 2]);
  assert.deepEqual(bodies.slice(1).map((message) => message.tool_call_id), ['call-1', 'call-2']);
  assert.equal(responses.every((response) => !response.writableEnded), true);
  await Promise.all(closed);
});

test('流式 AI 请求可由 AbortSignal 立即停止', async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('event: reasoning_delta\ndata: {"delta":"正在思考"}\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const controller = new AbortController();
  const request = postEventStream(
    `http://127.0.0.1:${server.address().port}/chat`,
    {},
    () => controller.abort(),
    5000,
    { signal: controller.signal },
  );

  await assert.rejects(request, (error) => error?.name === 'AbortError');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const axios = require('axios');
const { sendCustomAIControlMessage } = require('../../../src/app/backend/services/custom-ai-api');

const config = {
  enabled: true,
  baseUrl: 'https://api.example/v1',
  model: 'fixture-model',
  supportsTools: true,
  supportsReasoning: true,
};

test('自定义 OpenAI API 流式返回正文、思考和完整工具调用', async () => {
  const frames = [
    { choices: [{ delta: { content: '我先检查' } }] },
    { choices: [{ delta: { reasoning_content: '逐步分析' } }] },
    { choices: [{ delta: { tool_calls: [
      { index: 0, id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{' } },
    ] } }] },
    { choices: [{ delta: { tool_calls: [
      { index: 0, function: { arguments: '"x":1}' } },
    ] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const chunks = frames.map((frame) => 'data: ' + JSON.stringify(frame) + '\n\n').concat('data: [DONE]\n\n');
  const originalPost = axios.post;
  let requestPayload;
  let requestOptions;
  axios.post = async (_url, payload, options) => {
    requestPayload = payload;
    requestOptions = options;
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, data: Readable.from(chunks) };
  };
  const events = [];
  try {
    const result = await sendCustomAIControlMessage(config, [{ role: 'user', content: '开始' }], {
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
      onEvent: (event) => events.push(event),
    });
    assert.equal(requestPayload.stream, true);
    assert.equal(requestOptions.responseType, 'stream');
    assert.equal(result.ok, true);
    assert.equal(result.message.content, '我先检查');
    assert.equal(result.message.reasoning, '逐步分析');
    assert.deepEqual(result.message.tool_calls, [{
      id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"x":1}' },
    }]);
    assert.deepEqual(events.map((event) => [event.type, event.delta]), [
      ['content_delta', '我先检查'], ['reasoning_delta', '逐步分析'],
    ]);
  } finally {
    axios.post = originalPost;
  }
});

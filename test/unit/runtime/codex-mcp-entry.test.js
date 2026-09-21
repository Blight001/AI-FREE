'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { forwardMessage, handleLine } = require('../../../src/app/backend/runtime/codex-mcp/entry');

test('Codex stdio adapter reads the current descriptor and forwards JSON-RPC', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-codex-stdio-'));
  const descriptorPath = path.join(root, 'bridge.json');
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/mcp/v1');
    assert.equal(req.headers['x-ai-free-mcp-token'], 'token-a');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(descriptorPath, JSON.stringify({
      service: 'ai-free-external-mcp-gateway',
      endpoint: `http://127.0.0.1:${server.address().port}`,
      token: 'token-a',
    }), 'utf8');
    assert.deepEqual(await forwardMessage(descriptorPath, {
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    }), { jsonrpc: '2.0', id: 1, result: { ok: true } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex stdio adapter returns a sanitized connection error', async () => {
  let output = '';
  await handleLine('C:/does-not-exist/bridge.json', '{"jsonrpc":"2.0","id":7}', { write: (text) => { output += text; } });
  assert.deepEqual(JSON.parse(output), {
    jsonrpc: '2.0', id: 7,
    error: { code: -32000, message: '请先启动 AI-FREE' },
  });
});

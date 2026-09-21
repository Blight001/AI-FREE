'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { mcpToolResult } = require('../../../src/app/backend/services/mcp-tool-result');

test('MCP sends screenshots as vision content without duplicating base64 in metadata', () => {
  const response = mcpToolResult({ success: true, dataUrl: 'data:image/png;base64,aGVsbG8=', width: 100 });
  assert.deepEqual(response.content[1], { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' });
  assert.equal(response.structuredContent.image_attached, true);
  assert.equal(response.structuredContent.dataUrl, undefined);
  assert.equal(response.content[0].text.includes('aGVsbG8='), false);
  assert.equal(response.isError, false);
});

test('MCP preserves browser failures as tool failures and does not misclassify ordinary metadata', () => {
  for (const source of [{ success: false, errorCode: 'OBSERVATION_MISMATCH' }, { ok: false, error: 'offline' }]) {
    assert.equal(mcpToolResult(source).isError, true);
    assert.deepEqual(mcpToolResult(source).structuredContent, source);
  }
  assert.equal(mcpToolResult({ success: true, value: 'ok' }).content.length, 1);
  assert.equal(mcpToolResult({ dataUrl: 'https://example.test/image.png' }).content.length, 1);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { isAllowedBenchmarkTarget } = require('../../../src/app/backend/features/ai-chat/managed-chat-browser');

test('基准 MCP 连接仅允许本地测试 origin 和本轮工作区文件', () => {
  const grant = { allowedOrigins: ['http://127.0.0.1:41777'], workspaceRoot: 'C:/AI-Workspace',
    allowedWorkspaceDirectory: 'mcp-benchmark-run-abc' };
  assert.equal(isAllowedBenchmarkTarget(grant, 'browser_tab', { action: 'navigate', url: 'http://127.0.0.1:41777/path' }), true);
  assert.equal(isAllowedBenchmarkTarget(grant, 'browser_tab', { action: 'navigate', url: 'https://example.com' }), false);
  assert.equal(isAllowedBenchmarkTarget(grant, 'browser_tab', { action: 'navigate', url: 'javascript:alert(1)' }), false);
  assert.equal(isAllowedBenchmarkTarget(grant, 'browser_tab', { action: 'list' }), true);
  assert.equal(isAllowedBenchmarkTarget(grant, 'browser_tab', { action: 'switch', index: 0 }), false);
  assert.equal(isAllowedBenchmarkTarget(grant, 'browser_file', { action: 'upload', path: 'mcp-benchmark-run-abc/mcp-upload.txt' }), true);
  assert.equal(isAllowedBenchmarkTarget(grant, 'browser_file', { action: 'upload', path: 'other-user-file.txt' }), false);
  assert.equal(isAllowedBenchmarkTarget(grant, 'browser_file', { action: 'download', url: 'https://example.com/file', directory: 'mcp-benchmark-run-abc' }), false);
  assert.equal(isAllowedBenchmarkTarget(grant, 'browser_file', { action: 'download', url: 'http://127.0.0.1:41777/file' }), false);
  assert.equal(isAllowedBenchmarkTarget(grant, 'browser_file', { action: 'save_session', directory: 'mcp-benchmark-run-abc' }), false);
  assert.equal(isAllowedBenchmarkTarget(grant, 'browser_file', { action: 'download', url: 'http://127.0.0.1:41777/file', page_url: 'https://example.com' }), false);
  assert.equal(isAllowedBenchmarkTarget(grant, 'browser_media', { action: 'download' }), false);
  assert.equal(isAllowedBenchmarkTarget(grant, 'browser_page_batch', { steps: [] }), false);
});

test('绝对上传路径经规范化后不得绕出基准目录', () => {
  const root = path.resolve('C:/AI-Workspace/mcp-benchmark-run-abc');
  const grant = { allowedOrigins: ['http://127.0.0.1:41777'], workspaceRoot: 'C:/AI-Workspace', allowedWorkspaceDirectory: 'mcp-benchmark-run-abc' };
  assert.equal(isAllowedBenchmarkTarget(grant, 'browser_file', { action: 'upload', path: path.join(root, 'mcp-upload.txt') }), true);
  assert.equal(isAllowedBenchmarkTarget(grant, 'browser_file', { action: 'upload', path: path.resolve(root, '..', 'private.txt') }), false);
});

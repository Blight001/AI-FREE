'use strict';

// Read-only observation and a rejected stale action against an explicitly selected
// test browser in the installed app. Run with Node, an installed entry and target.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');
const fs = require('node:fs');

async function main() {
  const [entry, target, output] = process.argv.slice(2);
  assert(entry && target, 'Usage: node accept-installed-mcp.js <entry.js|server.mjs> <test-browser-id> [screenshot.png]');
  const descriptor = path.join(process.env.APPDATA, 'ai-free', 'ai-free-mcp-bridge.json');
  const child = spawn(process.execPath, [entry, '--descriptor', descriptor], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AI_FREE_MCP_DESCRIPTOR: descriptor },
  });
  const pending = new Map();
  let sequence = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const response = JSON.parse(line);
    pending.get(response.id)?.(response);
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 15000);
    pending.set(id, (response) => {
      clearTimeout(timer); pending.delete(id);
      if (response.error) reject(new Error(`MCP protocol error: ${response.error.code}`));
      else resolve(response.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'installed-acceptance', version: '1' } });
    const catalog = await request('tools/list');
    assert(catalog.tools.some((tool) => tool.name === 'browser_observe'));
    const result = await request('tools/call', { name: 'browser_observe', arguments: {
      change_browser: target, include_accessibility_tree: true, include_screenshot: true, mark: false,
    } });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.accessibilityTree.format, 'ax-tree-v1');
    assert.equal(result.structuredContent.dataUrl, undefined);
    const image = result.content.find((item) => item.type === 'image');
    assert.equal(image.mimeType, 'image/png');
    const bytes = Buffer.from(image.data, 'base64');
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert(!result.content.find((item) => item.type === 'text').text.includes(image.data));
    const failed = await request('tools/call', { name: 'browser_action', arguments: {
      change_browser: target, action: 'click', ref: 'missing-ref', observation_id: 'missing-observation',
    } });
    assert.equal(failed.isError, true);
    assert.equal(failed.structuredContent.success, false);
    if (output) fs.writeFileSync(path.resolve(output), bytes);
    console.log(JSON.stringify({ entry, imageBytes: bytes.length, axNodes: result.structuredContent.accessibilityTree.nodeCount,
      staleActionError: failed.structuredContent.errorCode, imageBlock: true, metadataWithoutBase64: true }));
  } finally {
    lines.close(); child.kill();
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });

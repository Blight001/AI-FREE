'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildCodexCopyText,
  buildCodexMcpConfig,
  createExternalCodexLink,
  mergeCodexConfig,
  writeCodexConfig,
} = require('../../../src/app/backend/services/external-codex-link');

test('Codex link uses a dynamic stdio adapter instead of a rotating HTTP token', () => {
  const config = buildCodexMcpConfig({
    executablePath: 'C:/AI-FREE/AI-FREE.exe',
    entryPath: 'C:/AI-FREE/codex-entry.js',
    descriptorPath: 'C:/AI-FREE/bridge.json',
  });
  assert.match(config, /command = /);
  assert.ok(config.includes(JSON.stringify('C:/AI-FREE/AI-FREE.exe')));
  assert.match(config, /--descriptor/);
  assert.doesNotMatch(config, /token|x-ai-free-mcp-token/);
});

test('copied Codex text is a setup prompt, not a raw config.toml dump', () => {
  const copyText = buildCodexCopyText({
    executablePath: 'C:/AI-FREE/AI-FREE.exe',
    entryPath: 'C:/AI-FREE/codex-entry.js',
    descriptorPath: 'C:/AI-FREE/bridge.json',
  });
  assert.match(copyText, /接到本机正在运行的 AI-FREE/);
  assert.match(copyText, /安装 Codex 插件/);
  assert.match(copyText, /codex mcp add ai_free/);
  assert.match(copyText, /AI-FREE\.exe/);
  assert.match(copyText, /--descriptor/);
  assert.doesNotMatch(copyText, /\[mcp_servers\.ai_free\]/);
  assert.doesNotMatch(copyText, /token|x-ai-free-mcp-token/);
});

test('Codex link updates only its managed block and preserves user config', () => {
  const config = '[mcp_servers.other]\nurl = "http://127.0.0.1:1"\n';
  const merged = mergeCodexConfig(config, 'command = "AI-FREE"\n');
  assert.match(merged, /mcp_servers\.other/);
  assert.match(merged, /BEGIN AI-FREE MCP/);
  const updated = mergeCodexConfig(merged, 'command = "AI-FREE-2"\n');
  assert.equal((updated.match(/BEGIN AI-FREE MCP/g) || []).length, 1);
  assert.match(updated, /AI-FREE-2/);
});

test('Codex link writes an atomic config and reports automatic connection', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-codex-link-'));
  try {
    const configPath = path.join(root, 'config.toml');
    fs.writeFileSync(configPath, '[mcp_servers.other]\n', 'utf8');
    writeCodexConfig(configPath, 'command = "AI-FREE"\n');
    assert.match(fs.readFileSync(configPath, 'utf8'), /BEGIN AI-FREE MCP/);
    assert.equal(fs.existsSync(`${configPath}.ai-free-backup`), true);

    const link = createExternalCodexLink({
      codexHome: root,
      executablePath: 'AI-FREE.exe',
      entryPath: 'codex-entry.js',
      descriptorPath: 'bridge.json',
    });
    assert.equal(link.connect().linked, true);
    assert.equal(link.getStatus().linked, true);
    assert.match(link.getConfig(), /AI-FREE\.exe/);
    assert.match(link.getCopyText(), /codex mcp add ai_free/);
    assert.doesNotMatch(link.getCopyText(), /\[mcp_servers\.ai_free\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

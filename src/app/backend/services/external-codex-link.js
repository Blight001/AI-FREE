'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const START_MARKER = '# BEGIN AI-FREE MCP - managed by AI-FREE';
const END_MARKER = '# END AI-FREE MCP';

function buildCodexMcpConfig({ executablePath, entryPath, descriptorPath }) {
  return [
    '[mcp_servers.ai_free]',
    `command = ${JSON.stringify(executablePath)}`,
    `args = ${JSON.stringify([entryPath, '--descriptor', descriptorPath])}`,
    'env = { ELECTRON_RUN_AS_NODE = "1" }',
    'startup_timeout_sec = 10',
    'tool_timeout_sec = 180',
    '',
  ].join('\n');
}

function buildCodexCopyText({ executablePath, entryPath, descriptorPath } = {}) {
  const command = JSON.stringify(String(executablePath || ''));
  const entry = JSON.stringify(String(entryPath || ''));
  const descriptor = JSON.stringify(String(descriptorPath || ''));
  return [
    '请把当前 Codex 接到本机正在运行的 AI-FREE，让我能调用 AI-FREE 已授权的 MCP 工具。',
    '',
    '请你完成这些事：',
    '1. 若还没装 Codex CLI，或还没在 VS Code / Cursor 安装 Codex 插件，先安装。',
    '2. 确认本机 AI-FREE 正在运行，并且已经登录已授权账号。',
    '3. 用 Codex 自己的 MCP 配置方式接入，优先执行下面命令（不要把这段当最终 config.toml 原文照搬）：',
    '',
    `codex mcp add ai_free --env ELECTRON_RUN_AS_NODE=1 -- ${command} ${entry} --descriptor ${descriptor}`,
    '',
    '4. 如果 `codex mcp add` 不可用，再按 Codex 当前格式写入 MCP server `ai_free`：stdio、command/args 如上、env 含 ELECTRON_RUN_AS_NODE=1、startup_timeout_sec=10、tool_timeout_sec=180。',
    '5. 不要把桥接密钥写进 Codex 配置。访问凭证由本机 adapter 从 descriptor 动态读取。',
    '6. 接入后用 `codex mcp list` 或 `/mcp` 确认 `ai_free` 已出现，然后调用 AI-FREE 的 MCP 工具。',
    '',
  ].join('\n');
}

function mergeCodexConfig(current, config) {
  const start = current.indexOf(START_MARKER);
  const end = current.indexOf(END_MARKER);
  const managed = `${START_MARKER}\n${config}${END_MARKER}`;
  if (start >= 0 || end >= 0) {
    if (start < 0 || end < start) throw new Error('Codex 中的 AI-FREE 配置区块不完整');
    return `${current.slice(0, start)}${managed}${current.slice(end + END_MARKER.length)}`;
  }
  if (/^\s*\[mcp_servers\.(?:ai_free|"ai_free"|'ai_free')(?:\]|\.)/m.test(current)) {
    throw new Error('Codex 已有自定义 ai_free 配置，请使用复制配置手动更新');
  }
  return `${current}${current && !current.endsWith('\n') ? '\n' : ''}\n${managed}\n`;
}

function resolveEntryPath(app, resourcesPath = process.resourcesPath) {
  if (app?.isPackaged && resourcesPath) {
    return path.join(resourcesPath, 'app.asar.unpacked', 'src', 'app', 'backend', 'runtime', 'codex-mcp', 'entry.js');
  }
  return path.join(__dirname, '..', 'runtime', 'codex-mcp', 'entry.js');
}

function writeCodexConfig(configPath, config) {
  const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const next = mergeCodexConfig(current, config);
  if (next === current) return;
  if (current) fs.copyFileSync(configPath, `${configPath}.ai-free-backup`);
  const temporary = `${configPath}.ai-free-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, next, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, configPath);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch (_) {}
  }
}

function createExternalCodexLink(options = {}) {
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const connection = {
    executablePath: options.executablePath || process.execPath,
    entryPath: options.entryPath || resolveEntryPath(options.app),
    descriptorPath: options.descriptorPath,
  };
  const config = buildCodexMcpConfig(connection);
  let status = { linked: false, message: '等待自动连接 Codex' };
  return {
    connect() {
      try {
        if (!fs.existsSync(codexHome)) {
          status = { linked: false, message: '未检测到 Codex，可复制说明给 Codex 连接' };
        } else {
          writeCodexConfig(path.join(codexHome, 'config.toml'), config);
          status = { linked: true, message: '已自动配置 Codex，新任务可连接' };
        }
      } catch (error) {
        status = { linked: false, message: error?.message || '自动连接失败，可复制说明给 Codex 连接' };
      }
      return { ...status };
    },
    getStatus: () => ({ ...status }),
    getConfig: () => config,
    getCopyText: () => buildCodexCopyText(connection),
  };
}

module.exports = {
  buildCodexCopyText,
  buildCodexMcpConfig,
  createExternalCodexLink,
  mergeCodexConfig,
  resolveEntryPath,
  writeCodexConfig,
};

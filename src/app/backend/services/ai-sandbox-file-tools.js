'use strict';

const fs = require('fs');
const path = require('path');
const { runCommandProcess } = require('./ai-command-process');

const RUN_COMMAND_TOOL_NAME = 'run_command';
const LEGACY_TOOL_NAME = 'sandbox_files';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
const TOOL_SCHEMA = {
  name: RUN_COMMAND_TOOL_NAME,
  destructive: true,
  description: '在 AI-Workspace 工作目录中执行命令行。支持 cmd、PowerShell 或系统 shell；返回退出码和有界输出。工作目录受限于 AI-Workspace，但不是虚拟机级系统隔离。',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['command'],
    properties: {
      command: { type: 'string', minLength: 1, maxLength: 20000, description: '要执行的命令行。' },
      shell: { type: 'string', enum: ['default', 'cmd', 'powershell'], description: '命令解释器，默认使用当前平台 shell。' },
      directory: { type: 'string', description: 'AI-Workspace 内的相对工作目录，默认根目录。' },
      timeout_ms: { type: 'number', minimum: 1000, maximum: MAX_TIMEOUT_MS, description: '超时毫秒数，默认 30000。' },
    },
  },
};

function resolveInside(rootDir, relativeDirectory = '') {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, String(relativeDirectory || '.'));
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('工作目录超出 AI 工作区');
  return { root, target, relative };
}

function commandEnvironment(root) {
  const allowed = ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP'];
  const env = Object.fromEntries(allowed.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  return { ...env, HOME: root, USERPROFILE: root, AI_WORKSPACE: root };
}

function resolveWorkingDirectory(root, directory) {
  const working = resolveInside(root, directory);
  if (!fs.existsSync(working.target) || !fs.statSync(working.target).isDirectory()) throw new Error('AI 工作区工作目录不存在');
  const realTarget = fs.realpathSync(working.target);
  resolveInside(root, path.relative(root, realTarget));
  return { ...working, target: realTarget };
}

/** @param {string} root @param {{command?: unknown, directory?: string, timeout_ms?: unknown, shell?: unknown}} input
 * @param {Parameters<typeof runCommandProcess>[1]} [options]
 */
function executeCommand(root, input, options) {
  const command = String(input.command || '').trim();
  if (!command) throw new Error('run_command 缺少 command');
  const working = resolveWorkingDirectory(root, input.directory);
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Number(input.timeout_ms) || DEFAULT_TIMEOUT_MS));
  return runCommandProcess({
    text: command, directory: working.relative || '.', cwd: working.target,
    shell: String(input.shell || 'default').trim().toLowerCase(), timeoutMs, env: commandEnvironment(root),
  }, options);
}

function createAiSandboxFileTools(options = {}) {
  const configuredDir = path.resolve(String(options.sandboxDir || 'AI-Workspace'));
  fs.mkdirSync(configuredDir, { recursive: true });
  const sandboxDir = fs.realpathSync(configuredDir);
  return {
    tools: [TOOL_SCHEMA],
    has: (name) => [RUN_COMMAND_TOOL_NAME, LEGACY_TOOL_NAME].includes(String(name || '')),
    execute: async (name, args = {}, executionOptions = undefined) => {
      if (![RUN_COMMAND_TOOL_NAME, LEGACY_TOOL_NAME].includes(String(name || ''))) throw new Error(`未知的命令工具: ${name}`);
      return executeCommand(sandboxDir, args && typeof args === 'object' ? args : {}, executionOptions);
    },
  };
}

module.exports = { createAiSandboxFileTools, executeCommand, resolveInside, RUN_COMMAND_TOOL_NAME };

'use strict';

const fs = require('fs');
const http = require('http');
const readline = require('readline');

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

function readConnection(descriptorPath) {
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
  const endpoint = new URL(descriptor.endpoint);
  if (descriptor.service !== 'ai-free-external-mcp-gateway'
    || endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1'
    || endpoint.username || endpoint.password || !descriptor.token) {
    throw new Error('AI-FREE 本机桥接信息无效');
  }
  endpoint.pathname = '/mcp/v1';
  endpoint.search = '';
  return { endpoint, token: String(descriptor.token) };
}

function postMessage(connection, message) {
  const body = JSON.stringify(message);
  return new Promise((resolve, reject) => {
    const req = http.request(connection.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body),
        'x-ai-free-mcp-token': connection.token,
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_MESSAGE_BYTES) res.destroy(new Error('AI-FREE 工具结果过大'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(180000, () => req.destroy(new Error('AI-FREE MCP 请求超时')));
    req.end(body);
  });
}

async function forwardMessage(descriptorPath, message) {
  let result = await postMessage(readConnection(descriptorPath), message);
  // Authentication failed before dispatch, so a single retry cannot repeat a tool action.
  if (result.status === 401) result = await postMessage(readConnection(descriptorPath), message);
  if (result.status === 202) return null;
  const response = JSON.parse(result.text || '{}');
  if (result.status !== 200) throw new Error(response.message || 'AI-FREE MCP 暂不可用');
  return response;
}

async function handleLine(descriptorPath, line, output) {
  let message;
  try {
    if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) throw new Error('MCP 请求过大');
    message = JSON.parse(line);
    const response = await forwardMessage(descriptorPath, message);
    if (message.id !== undefined && response) output.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    if (message && message.id === undefined) return;
    output.write(`${JSON.stringify({
      jsonrpc: '2.0', id: message?.id ?? null,
      error: { code: -32000, message: error?.code === 'ENOENT' ? '请先启动 AI-FREE' : 'AI-FREE MCP 连接失败，请检查软件和账号授权状态' },
    })}\n`);
  }
}

function runStdio(descriptorPath, input = process.stdin, output = process.stdout) {
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  lines.on('line', (line) => { if (line.trim()) void handleLine(descriptorPath, line, output); });
  return lines;
}

if (require.main === module) {
  const index = process.argv.indexOf('--descriptor');
  runStdio(index >= 0 ? process.argv[index + 1] : '');
}

module.exports = { forwardMessage, handleLine, readConnection, runStdio };

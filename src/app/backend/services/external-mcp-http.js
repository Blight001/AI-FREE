'use strict';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const MAX_BODY_BYTES = 1024 * 1024;

function jsonResponse(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function mcpResponse(res, payload, statusCode = 200) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
  });
  res.end(body);
}

async function runWhileConnected(res, operation) {
  const controller = new AbortController();
  const disconnect = () => controller.abort();
  res.once('close', disconnect);
  try {
    if (res.destroyed) disconnect();
    return await operation(controller.signal);
  } finally {
    res.off('close', disconnect);
  }
}

function mcpError(id, code, message, data = undefined) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

module.exports = { MCP_PROTOCOL_VERSION, jsonResponse, mcpResponse, runWhileConnected, mcpError, readJson };

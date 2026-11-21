const axios = require('axios');
const { StringDecoder } = require('node:string_decoder');
const { normalizeCustomAiApiConfig } = require('../utils/ai-control-settings');
const { normalizeToolCallMessage } = require('../lib/ai-tool-call-normalizer');

function resolveChatCompletionsUrl(baseUrl) {
  const raw = String(baseUrl || '').trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new Error('自定义 API 地址无效，请填写完整的 HTTP(S) 地址');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('自定义 API 仅支持 HTTP(S) 地址');
  }
  parsed.hash = '';
  parsed.search = '';
  const pathname = parsed.pathname.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(pathname)) {
    parsed.pathname = pathname;
  } else if (/\/v\d+$/i.test(pathname)) {
    parsed.pathname = `${pathname}/chat/completions`;
  } else {
    parsed.pathname = `${pathname}/v1/chat/completions`.replace(/\/{2,}/g, '/');
  }
  return parsed.toString();
}

function resolveModelsUrl(baseUrl) {
  const raw = String(baseUrl || '').trim();
  let parsed;
  try { parsed = new URL(raw); } catch (_) { throw new Error('自定义 API 地址无效，请填写完整的 HTTP(S) 地址'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('自定义 API 仅支持 HTTP(S) 地址');
  parsed.search = '';
  parsed.hash = '';
  let pathname = parsed.pathname.replace(/\/+$/, '');
  pathname = pathname.replace(/\/chat\/completions$/i, '').replace(/\/models$/i, '');
  if (!/\/v\d+$/i.test(pathname)) pathname = `${pathname}/v1`;
  parsed.pathname = `${pathname}/models`.replace(/\/{2,}/g, '/');
  return parsed.toString();
}

async function fetchCustomAiModels(config, client = axios) {
  const normalized = normalizeCustomAiApiConfig(config);
  if (!normalized.baseUrl) throw new Error('请先填写 API 地址');
  const headers = normalized.apiKey ? { Authorization: `Bearer ${normalized.apiKey}` } : {};
  const response = await client.get(resolveModelsUrl(normalized.baseUrl), {
    headers,
    timeout: 20000,
    maxRedirects: 0,
    maxContentLength: 2 * 1024 * 1024,
    validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`获取模型列表失败：${getCustomAiErrorDetail(response.data, response.status)}`);
  }
  const items = Array.isArray(response.data?.data) ? response.data.data : [];
  return items.map((item) => ({
    id: String(item?.id || '').trim().slice(0, 200),
    name: String(item?.name || item?.id || '').trim().slice(0, 200),
  })).filter((item) => item.id);
}

function normalizeMessage(message = {}, options) {
  const { role: sourceRole, content, tool_calls, reasoning, tool_call_id, name } = message;
  const role = String(sourceRole || 'user');
  const normalized = { role, content: content ?? '' };
  if (role === 'assistant' && Array.isArray(tool_calls)) normalized.tool_calls = tool_calls;
  if (role === 'assistant' && options.customProtocol && reasoning) normalized.reasoning_content = String(reasoning);
  if (role === 'tool') Object.assign(normalized, { tool_call_id: String(tool_call_id || ''), ...(name && { name: String(name) }) });
  return normalized;
}

function normalizeMessages(messages = [], options = {}) {
  return (Array.isArray(messages) ? messages : []).map((message) => normalizeMessage(message ?? {}, options));
}

function contentHasImageInput(content) {
  if (!Array.isArray(content)) return false;
  return content.some((part) => (
    String(part?.type || '').toLowerCase() === 'image_url' && Boolean(part?.image_url?.url)
  ));
}

function messagesHaveImageInput(messages = []) {
  return (Array.isArray(messages) ? messages : []).some((message) => contentHasImageInput(message?.content));
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nativeOpenAiFunction(tool) {
  return tool.type === 'function' && isRecord(tool.function) ? tool.function : null;
}

function toolParameters(tool, nativeFunction) {
  return nativeFunction?.parameters
    || tool.input_schema
    || tool.inputSchema
    || tool.parameters
    || { type: 'object', properties: {} };
}

function normalizeOpenAiTool(tool) {
  if (!isRecord(tool)) return null;
  const nativeFunction = nativeOpenAiFunction(tool);
  const name = String(nativeFunction?.name || tool.name || '').trim();
  if (!name) return null;
  const description = nativeFunction?.description ?? tool.description;
  const fn = { ...(nativeFunction || {}), name, parameters: toolParameters(tool, nativeFunction) };
  if (description) fn.description = String(description);
  return {
    type: 'function',
    function: fn,
  };
}

function normalizeOpenAiTools(tools = []) {
  return (Array.isArray(tools) ? tools : []).map(normalizeOpenAiTool).filter(Boolean);
}

function buildCustomAiRequest(normalized, messages, options) {
  const headers = { 'Content-Type': 'application/json' };
  if (normalized.apiKey) headers.Authorization = `Bearer ${normalized.apiKey}`;
  const payload = {
    model: normalized.model,
    messages: normalizeMessages(messages, { customProtocol: normalized.customProtocol }),
    stream: options.stream === true,
  };
  if (normalized.maxOutputTokens) payload.max_tokens = normalized.maxOutputTokens;
  const tools = normalizeOpenAiTools(options.tools);
  if (tools.length) payload.tools = tools;
  return { headers, payload };
}

function getCustomAiResponseData(response) {
  return response && response.data && typeof response.data === 'object' ? response.data : {};
}

function mergeFunctionDelta(previous = {}, delta = {}) {
  return {
    ...previous,
    ...(delta.name ? { name: `${previous.name || ''}${delta.name}` } : {}),
    ...(delta.arguments ? { arguments: `${previous.arguments || ''}${delta.arguments}` } : {}),
  };
}

function mergeToolCallDelta(toolCalls, delta) {
  const index = Number(delta?.index) || 0;
  const previous = toolCalls[index] || { function: { arguments: '' } };
  toolCalls[index] = {
    ...previous,
    ...(delta?.id ? { id: `${previous.id || ''}${delta.id}` } : {}),
    ...(delta?.type ? { type: delta.type } : {}),
    function: mergeFunctionDelta(previous.function, delta?.function),
  };
}

function parseCustomAiEvent(block) {
  const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart()).join('\n');
  if (!data || data === '[DONE]') return null;
  try { return JSON.parse(data); } catch (_) { return null; }
}

function appendStreamContent(state, delta, onEvent) {
  if (typeof delta !== 'string' || !delta) return;
  state.message.content += delta;
  onEvent?.({ type: 'content_delta', delta });
}

function appendStreamReasoning(state, delta, onEvent) {
  if (typeof delta !== 'string' || !delta) return;
  state.message.reasoning_content = (state.message.reasoning_content || '') + delta;
  onEvent?.({ type: 'reasoning_delta', delta });
}

function applyCustomAiEvent(block, state, onEvent, supportsReasoning) {
  const payload = parseCustomAiEvent(block);
  if (!payload) return;
  if (payload.error) { state.error = payload.error.message || payload.error; return; }
  state.usage = payload.usage || state.usage;
  const delta = payload.choices?.[0]?.delta || {};
  appendStreamContent(state, delta.content, onEvent);
  if (supportsReasoning) appendStreamReasoning(state, delta.reasoning_content ?? delta.reasoning, onEvent);
  (delta.tool_calls || []).forEach((toolCall) => mergeToolCallDelta(state.toolCalls, toolCall));
}

async function readCustomAiEventStream(response, onEvent, supportsReasoning) {
  if (typeof response.data?.[Symbol.asyncIterator] !== 'function') {
    return normalizeCustomAiSuccess(getCustomAiResponseData(response), supportsReasoning);
  }
  const chunks = [];
  const state = { message: { role: 'assistant', content: '' }, toolCalls: [], usage: null, error: null };
  let buffer = '';
  const decoder = new StringDecoder('utf8');
  for await (const chunk of response.data) {
    const bytes = Buffer.from(chunk);
    chunks.push(bytes);
    buffer += decoder.write(bytes);
    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary >= 0) {
      const separator = /^\r?\n\r?\n/.exec(buffer.slice(boundary))[0];
      applyCustomAiEvent(buffer.slice(0, boundary), state, onEvent, supportsReasoning);
      buffer = buffer.slice(boundary + separator.length);
      boundary = buffer.search(/\r?\n\r?\n/);
    }
  }
  buffer += decoder.end();
  if (buffer.trim()) applyCustomAiEvent(buffer, state, onEvent, supportsReasoning);
  if (state.error) return { ok: false, message: String(state.error) };
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!response.headers?.['content-type']?.toLowerCase().includes('text/event-stream')) {
    try { return normalizeCustomAiSuccess(JSON.parse(raw), supportsReasoning); } catch (_) {
      return { ok: false, message: '自定义 API 返回格式无效：无法解析流式响应' };
    }
  }
  if (state.toolCalls.length) state.message.tool_calls = state.toolCalls;
  return normalizeCustomAiSuccess({ choices: [{ message: state.message }], usage: state.usage }, supportsReasoning);
}

function getCustomAiErrorDetail(data, status) {
  const error = data && data.error;
  return (error && error.message) || (data && data.message) || `HTTP ${status}`;
}

function normalizeCustomAiSuccess(data, supportsReasoning) {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const message = choices[0] && choices[0].message;
  if (!message || typeof message !== 'object') {
    return { ok: false, message: '自定义 API 返回格式无效：缺少 choices[0].message' };
  }
  const normalizedMessage = normalizeToolCallMessage(message);
  return {
    ok: true,
    message: {
      role: 'assistant',
      content: normalizedMessage.content,
      reasoning: supportsReasoning ? String(message.reasoning_content || message.reasoning || '') : '',
      tool_calls: normalizedMessage.toolCalls,
    },
    usage: data.usage || null,
    custom_api: true,
  };
}

function validateCustomAiChat(config, messages) {
  const normalized = normalizeCustomAiApiConfig(config);
  if (!normalized.enabled || !normalized.baseUrl || !normalized.model) {
    return { error: { ok: false, message: '自定义 API 尚未配置完整' } };
  }
  if (messagesHaveImageInput(messages) && !normalized.supportsImageInput) {
    return { error: {
      message: `当前模型“${normalized.name}”未启用图片输入，无法读取 browser_screenshot 截图。请在自定义 API 配置中开启“支持图片输入”，或切换到视觉模型。`,
      errorCode: 'MODEL_IMAGE_INPUT_UNSUPPORTED',
      ok: false,
    } };
  }
  return { normalized };
}

async function sendCustomAIControlMessage(config, messages, options = {}) {
  const validation = validateCustomAiChat(config, messages);
  if (validation.error) return validation.error;
  const normalized = validation.normalized;
  if (!normalized.supportsTools) options = { ...options, tools: [] };

  const streaming = typeof options.onEvent === 'function';
  const { headers, payload } = buildCustomAiRequest(normalized, messages, { ...options, stream: streaming });

  try {
    const response = await axios.post(resolveChatCompletionsUrl(normalized.baseUrl), payload, {
      headers,
      signal: options.signal,
      timeout: 240000,
      maxContentLength: 20 * 1024 * 1024,
      maxBodyLength: 20 * 1024 * 1024,
      validateStatus: () => true,
      ...(streaming ? { responseType: 'stream' } : {}),
    });
    if (streaming && response.status >= 200 && response.status < 300) {
      return await readCustomAiEventStream(response, options.onEvent, normalized.supportsReasoning);
    }
    const data = getCustomAiResponseData(response);
    if (response.status < 200 || response.status >= 300) {
      const detail = getCustomAiErrorDetail(data, response.status);
      return { ok: false, message: `自定义 API 请求失败：${detail}` };
    }
    return normalizeCustomAiSuccess(data, normalized.supportsReasoning);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return { ok: false, message: `自定义 API 请求失败：${message}` };
  }
}

module.exports = {
  messagesHaveImageInput,
  normalizeMessages,
  normalizeOpenAiTools,
  resolveChatCompletionsUrl,
  resolveModelsUrl,
  fetchCustomAiModels,
  sendCustomAIControlMessage,
};

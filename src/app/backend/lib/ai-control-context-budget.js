'use strict';

const { contextLimitError, groupValidMessages, messageTokenEstimate } = require('./ai-control-message-window');
const { compactToolContent, omitToolImage } = require('./ai-control-tool-result-budget');

const DEFAULT_MAX_REQUEST_CHARS = 60000;
const DEFAULT_TOOL_IMAGE_CHARS = 96000;
const DEFAULT_TOOL_RESULT_CHARS = 12000;
const DEFAULT_TEXT_MESSAGE_CHARS = 16000;
const DEFAULT_SUMMARY_CHARS = 6000;

function serializedLength(messages, tools) {
  try { return JSON.stringify({ messages, tools }).length; } catch (_) { return Number.MAX_SAFE_INTEGER; }
}

function truncateMiddle(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  const marker = `\n...[已截短 ${text.length - maxChars} 字符]...\n`;
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available * 0.7);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (available - head))}`;
}

function compactToolCalls(toolCalls, maxArgumentChars) {
  if (!Array.isArray(toolCalls)) return toolCalls;
  return toolCalls.map((call) => {
    const args = String(call?.function?.arguments || '');
    if (args.length <= maxArgumentChars) return call;
    return {
      ...call,
      function: {
        ...(call.function || {}),
        arguments: JSON.stringify({
          _truncated: true,
          original_chars: args.length,
          preview: truncateMiddle(args, Math.max(200, maxArgumentChars - 80)),
        }),
      },
    };
  });
}

function compactMessage(message, limits) {
  const copy = { ...message };
  delete copy.reasoning;
  delete copy.tool_events;
  delete copy.trace_events;
  delete copy.artifacts;
  delete copy.artifactReferences;
  if (copy.role === 'tool') {
    copy.content = compactToolContent(String(copy.content ?? ''), limits.toolResultChars);
  } else if (!limits.preserveContent && typeof copy.content === 'string') {
    copy.content = truncateMiddle(copy.content, limits.textMessageChars);
  }
  if (copy.role === 'assistant' && Array.isArray(copy.tool_calls)) {
    copy.tool_calls = compactToolCalls(copy.tool_calls, limits.toolArgumentChars);
  }
  return copy;
}

function isUserRequest(message) {
  return message?.role === 'user' && message.ai_free_transient_image !== true
    && message.ai_free_attachment_context !== true;
}

function summaryLines(groups, maxChars) {
  const lines = [];
  let used = 0;
  for (const group of groups) {
    for (const message of group) {
      if (!isUserRequest(message) && (message?.role !== 'assistant' || message.tool_calls?.length)) continue;
      const content = String(message.content || '').replace(/\s+/g, ' ').trim();
      if (!content) continue;
      const label = message.role === 'user' ? '用户' : '助手';
      const line = `${label}：${truncateMiddle(content, 360)}`;
      if (used + line.length > maxChars) return lines;
      lines.push(line);
      used += line.length + 1;
    }
  }
  return lines;
}

function createHistorySummary(groups, maxChars) {
  if (!groups.length || maxChars < 80) return null;
  const heading = `[较早对话摘要：已压缩 ${groups.length} 个消息组]`;
  const lines = summaryLines(groups, Math.max(0, maxChars - heading.length - 1));
  return lines.length ? { role: 'assistant', content: [heading, ...lines].join('\n') } : null;
}

function partitionGroups(messages) {
  const system = [];
  const conversation = [];
  for (const group of groupValidMessages(messages)) {
    if (group.length === 1 && group[0]?.role === 'system') system.push(...group);
    else conversation.push(group);
  }
  return { system, conversation };
}

function normalizeLimits(options = {}) {
  return {
    maxRequestChars: Number(options.maxRequestChars) || DEFAULT_MAX_REQUEST_CHARS,
    toolImageChars: Math.max(0, Number(options.toolImageChars ?? DEFAULT_TOOL_IMAGE_CHARS)),
    toolResultChars: Number(options.toolResultChars) || DEFAULT_TOOL_RESULT_CHARS,
    textMessageChars: Number(options.textMessageChars) || DEFAULT_TEXT_MESSAGE_CHARS,
    summaryChars: Number(options.summaryChars) || DEFAULT_SUMMARY_CHARS,
    toolArgumentChars: Number(options.toolArgumentChars) || 8000,
    contextWindow: Number(options.contextWindow) || 0,
  };
}

function createRequestSizer(tools, contextWindow) {
  const overhead = serializedLength([], tools);
  const sizes = new WeakMap();
  function chars(messages) {
    let length = overhead + Math.max(0, messages.length - 1);
    for (const message of messages) {
      if (!sizes.has(message)) sizes.set(message, JSON.stringify(message).length);
      length += sizes.get(message);
    }
    return length;
  }
  function fits(messages, maxChars) {
    if (contextWindow > 0) {
      const estimated = messages.reduce((total, message) => total + messageTokenEstimate(message), 0);
      if (estimated > contextWindow) return false;
    }
    return chars(messages) <= maxChars;
  }
  return { chars, fits };
}
function projectGroup(group, limits) {
  const images = group.filter((message) => message.ai_free_transient_image === true);
  const imageIds = new Set(images.map((message) => message.ai_free_tool_call_id));
  const originalTools = new Map();
  const messages = group.filter((message) => message.ai_free_transient_image !== true).map((message) => {
    if (message.role !== 'tool' || !imageIds.has(message.tool_call_id)) return compactMessage(message, limits);
    originalTools.set(message.tool_call_id, message);
    return compactMessage(omitToolImage(message, 'context_budget'), limits);
  });
  return { messages, images, originalTools, limits };
}

function requiredGroups(conversation, requestIndex) {
  const required = new Set([conversation.length - 1]);
  if (requestIndex < 0) return required;
  required.add(requestIndex);
  for (let index = requestIndex + 1; index < conversation.length; index += 1) {
    if (conversation[index][0]?.ai_free_attachment_context === true) required.add(index);
  }
  return required;
}

function flattenGroups(selected) {
  return [...selected.entries()].sort(([a], [b]) => a - b).flatMap(([, group]) => group.messages);
}

function collectRecentGroups(system, conversation, sizer, limits, required) {
  const kept = new Map();
  const add = (index, preserveContent) => kept.set(index, projectGroup(conversation[index], { ...limits, preserveContent }));
  for (const index of required) {
    if (index >= 0) add(index, isUserRequest(conversation[index][0]) || conversation[index][0]?.ai_free_attachment_context === true);
  }
  const check = () => sizer.fits([...system, ...flattenGroups(kept)], limits.maxRequestChars);
  if (!check()) return null;
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    if (kept.has(index)) continue;
    add(index, false);
    if (check()) continue;
    kept.delete(index);
    break;
  }
  return kept;
}

function selectGroups(system, conversation, sizer, limits, required) {
  const initial = collectRecentGroups(system, conversation, sizer, limits, required);
  if (initial) return initial;
  for (const cap of [2000, 512, 128]) {
    const selected = collectRecentGroups(system, conversation, sizer, {
      ...limits, toolResultChars: Math.min(cap, limits.toolResultChars),
      toolArgumentChars: Math.min(limits.toolArgumentChars, Math.max(256, cap)),
    }, required);
    if (selected) return selected;
  }
  throw contextLimitError();
}

function addHistorySummary(system, conversation, selected, sizer, limits) {
  const omitted = conversation.filter((_group, index) => !selected.has(index));
  const messages = flattenGroups(selected);
  const remaining = limits.maxRequestChars - sizer.chars([...system, ...messages]);
  const summary = createHistorySummary(omitted, Math.min(limits.summaryChars, remaining - 80));
  if (!summary || !sizer.fits([...system, summary, ...messages], limits.maxRequestChars)) return system;
  return [...system, summary];
}

function reattachGroupImage(group, image) {
  const { ai_free_tool_call_id: id, ...envelope } = image;
  const original = group.originalTools.get(id);
  if (!original) return null;
  const tool = compactMessage(original, group.limits);
  const messages = group.messages.map((message) => message.tool_call_id === id ? tool : message);
  return { ...group, messages: [...messages, envelope] };
}

function restoreToolImages(prefix, selected, sizer, limits) {
  let available = limits.toolImageChars;
  const totalChars = limits.maxRequestChars + available;
  for (const index of [...selected.keys()].sort((a, b) => b - a)) {
    const group = selected.get(index);
    for (const image of group.images) {
      const size = JSON.stringify(image).length + 1;
      if (size > available) continue;
      const candidate = reattachGroupImage(selected.get(index), image);
      if (!candidate) continue;
      const previous = selected.get(index);
      selected.set(index, candidate);
      if (sizer.fits([...prefix, ...flattenGroups(selected)], totalChars)) available -= size;
      else selected.set(index, previous);
    }
  }
}

function fitAiControlContext(messages = [], tools = [], options = {}) {
  const limits = normalizeLimits(options);
  if (limits.contextWindow > 0 && tools.length) {
    limits.contextWindow -= Math.ceil(JSON.stringify(tools).length / 4);
    if (limits.contextWindow <= 0) throw contextLimitError();
  }
  const { system, conversation } = partitionGroups(messages);
  const prefix = system.map((message) => compactMessage(message, { ...limits, preserveContent: true }));
  const requestIndex = conversation.map((group) => isUserRequest(group[0])).lastIndexOf(true);
  const required = requiredGroups(conversation, requestIndex);
  const sizer = createRequestSizer(tools, limits.contextWindow);
  // Attachment ingress already limits the size of explicit user inputs. Reserve their cost once,
  // while keeping the model window check and the tool-image allocation independent.
  const attachments = [...prefix, ...[...required].flatMap((index) => conversation[index] || [])]
    .filter((message) => message.ai_free_attachment_context === true);
  limits.maxRequestChars += sizer.chars(attachments) - sizer.chars([]);
  const selected = selectGroups(prefix, conversation, sizer, limits, required);
  restoreToolImages(prefix, selected, sizer, limits);
  const withSummary = addHistorySummary(prefix, conversation, selected, sizer, limits);
  return [...withSummary, ...flattenGroups(selected)];
}

module.exports = {
  DEFAULT_MAX_REQUEST_CHARS,
  compactMessage,
  createHistorySummary,
  fitAiControlContext,
  serializedLength,
  truncateMiddle,
};

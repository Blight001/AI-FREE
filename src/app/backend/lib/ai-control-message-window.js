'use strict';

function toolCallIds(message) {
  if (String(message?.role || '') !== 'assistant' || !Array.isArray(message?.tool_calls)) return [];
  return message.tool_calls.map((call) => String(call?.id || '').trim()).filter(Boolean);
}

function readToolRound(source, start) {
  const tools = [];
  let cursor = start;
  while (cursor < source.length && source[cursor].role === 'tool') {
    tools.push(source[cursor]);
    cursor += 1;
  }
  // Keep the image envelopes with their tool round during context pruning.
  while (cursor < source.length && source[cursor].ai_free_transient_image === true) cursor += 1;
  return { tools, messages: source.slice(start, cursor), cursor };
}

function groupValidMessages(messages = []) {
  const source = Array.isArray(messages) ? messages.filter((item) => item && typeof item === 'object') : [];
  const groups = [];
  for (let index = 0; index < source.length; index += 1) {
    const message = source[index];
    if (String(message?.role || '') === 'tool') continue;

    const ids = toolCallIds(message);
    if (!ids.length) {
      groups.push([message]);
      continue;
    }

    const round = readToolRound(source, index + 1);
    const returnedIds = new Set(round.tools.map((item) => String(item.tool_call_id || '').trim()).filter(Boolean));
    if (ids.every((id) => returnedIds.has(id))) {
      groups.push([message, ...round.messages]);
    } else {
      // OpenAI 兼容接口会拒绝不完整的工具调用链。只清除无法配对的
      // tool_calls，保留助手文本；正常对话内容不做数量或字符裁剪。
      const { tool_calls: _discarded, ...plainAssistant } = message;
      if (String(plainAssistant.content || '').trim()) groups.push([plainAssistant]);
    }
    index = round.cursor - 1;
  }
  return groups;
}

function messageTokenEstimate(message) {
  const countText = (value) => Math.ceil(String(value || '').length / 4);
  let tokens = 4 + countText(message?.name);
  if (typeof message?.content === 'string') tokens += countText(message.content);
  if (Array.isArray(message?.content)) {
    for (const part of message.content) {
      if (part?.type === 'image_url') tokens += 1024;
      else tokens += countText(part?.text || part?.content || '');
    }
  }
  if (Array.isArray(message?.tool_calls)) tokens += countText(JSON.stringify(message.tool_calls));
  return tokens;
}

function contextTurns(groups) {
  const prefix = [];
  const turns = [];
  let current = null;
  for (const group of groups) {
    if (group.length === 1 && group[0]?.role === 'system') {
      prefix.push(group);
      continue;
    }
    const startsTurn = group[0]?.role === 'user'
      && group[0]?.ai_free_transient_image !== true
      && group[0]?.ai_free_attachment_context !== true;
    if (startsTurn) {
      current = [];
      turns.push(current);
    }
    if (current) current.push(group);
    else prefix.push(group);
  }
  return { prefix, turns };
}

function contextLimitError() {
  /** @type {Error & { code?: string }} */
  const error = new Error('当前对话超出模型输入上下文上限，且无法在保留完整工具调用的前提下继续裁剪。请缩短输入或选择更大上下文的模型。');
  error.code = 'AI_CONTEXT_WINDOW_LIMIT';
  return error;
}

function limitAiControlMessages(messages = [], contextWindow = 0) {
  const groups = groupValidMessages(messages);
  const limit = Math.floor(Number(contextWindow) || 0);
  if (limit <= 0 || groups.flat().reduce((total, message) => total + messageTokenEstimate(message), 0) <= limit) {
    return groups.flat();
  }
  const { prefix, turns } = contextTurns(groups);
  const prefixTokens = prefix.flat().reduce((total, message) => total + messageTokenEstimate(message), 0);
  if (prefixTokens >= limit || !turns.length) throw contextLimitError();
  const kept = [];
  let used = prefixTokens;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const size = turn.flat().reduce((total, message) => total + messageTokenEstimate(message), 0);
    if (used + size > limit) {
      if (!kept.length) throw contextLimitError();
      break;
    }
    kept.unshift(turn);
    used += size;
  }
  return [...prefix, ...kept].flat(2);
}

module.exports = {
  contextLimitError,
  groupValidMessages,
  limitAiControlMessages,
  messageTokenEstimate,
};

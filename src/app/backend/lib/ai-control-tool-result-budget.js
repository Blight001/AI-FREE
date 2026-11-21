'use strict';

const RESULT_FIELDS = [
  'success', 'ok', 'status', 'errorCode', 'error_code', 'code', 'retryable', 'recoverable',
  'error', 'message', 'reason', 'suggestedTool', 'action', 'acquired', 'controlled',
  'observationId', 'takeoverActive', 'activeTabId', 'tabId', 'url', 'surface', 'viewport', 'coordinateSpace',
  'image_attached', 'image_omitted_reason', 'image_input_unsupported', 'image_labels',
  'truncated', 'itemsTruncated', 'returnedCount', 'totalMatched', 'requestedTextLimit', 'appliedTextLimit',
  'limitCapped', 'capReason', 'filter', 'filters', 'keyword', 'query', 'region', 'regionLayoutHash',
  'observation', 'items',
];
const ITEM_FIELDS = [
  'id', 'ref', 'stableRef', 'selector', 'elementId', 'testId', 'role', 'tag', 'label', 'name',
  'ariaLabel', 'x', 'y', 'clickX', 'clickY', 'width', 'height', 'bounds', 'coordinateSpace',
  'surface', 'selectorUnique', 'selectorStability', 'disabled', 'checked', 'requiresFileUpload',
  'inputType', 'mediaUrl', 'downloadUrl', 'mediaType', 'text',
];
const PREVIEW_FIELDS = new Set(['text', 'error', 'message', 'warning', 'stdout', 'stderr']);
const OMITTED = '{"_context_omitted":true}';

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function parseToolContent(content) {
  try { return JSON.parse(content); } catch (_) { return content; }
}

function compactItems(items, budget) {
  const kept = [];
  let available = budget - 2;
  for (const item of items) {
    const raw = JSON.stringify(item);
    const size = Math.min(340, available);
    if (size < 80) break;
    const encoded = raw.length <= size ? raw : compactRecord(item, size, ITEM_FIELDS);
    if (encoded === OMITTED) continue;
    kept.push(encoded);
    available -= encoded.length + 1;
  }
  return { encoded: `[${kept.join(',')}]`, omitted: items.length - kept.length };
}

function compactField(key, value, available) {
  if (key === 'observation') return compactRecord(value, available, RESULT_FIELDS);
  if (typeof value === 'string' && PREVIEW_FIELDS.has(key)) {
    const limit = key === 'text' ? 80 : 240;
    if (value.length > limit) return JSON.stringify(`${value.slice(0, limit)}…`);
  }
  const encoded = JSON.stringify(value);
  // Preserve complete values. A partial selector, ref or URL is unsafe to act on.
  return encoded.length <= Math.min(available, 512) ? encoded : '';
}

function compactRecord(value, budget, priority) {
  const fields = [OMITTED.slice(1, -1)];
  let available = budget - OMITTED.length;
  if (!record(value)) return OMITTED;
  for (const key of new Set([...priority, ...Object.keys(value)])) {
    if (!Object.hasOwn(value, key) || key.startsWith('_context_')) continue;
    const name = JSON.stringify(key);
    const room = available - name.length - 2;
    if (room < 2) continue;
    if (key === 'items' && Array.isArray(value[key])) {
      const diagnostic = '"_context_items_omitted":';
      const reserve = diagnostic.length + String(value[key].length).length + 1;
      if (room < reserve + 2) continue;
      const { encoded, omitted } = compactItems(value[key], room - reserve);
      fields.push(`${name}:${encoded}`);
      available -= name.length + encoded.length + 2;
      if (omitted) {
        fields.push(`${diagnostic}${omitted}`);
        available -= reserve;
      }
      continue;
    }
    const encoded = compactField(key, value[key], room);
    if (!encoded || encoded.length > room) continue;
    fields.push(`${name}:${encoded}`);
    available -= name.length + encoded.length + 2;
  }
  return `{${fields.join(',')}}`;
}

function compactToolContent(content, budget) {
  if (content.length <= budget) return content;
  const result = parseToolContent(content);
  if (record(result)) return compactRecord(result, budget, RESULT_FIELDS);
  if (Array.isArray(result)) return compactRecord({ items: result }, budget, RESULT_FIELDS);
  return JSON.stringify({ _context_omitted: true, preview: String(result).slice(0, Math.floor(budget / 8)) });
}

function omitToolImage(message, reason, warning = '') {
  const result = parseToolContent(message.content);
  if (!record(result) || (result.image_attached !== true && result.observation?.image_attached !== true)) return message;
  result.image_attached = false;
  result.image_omitted_reason = reason;
  delete result.image_labels;
  if (result.observation?.image_attached === true) result.observation.image_attached = false;
  if (warning) {
    result.image_input_unsupported = true;
    result.warning = warning;
    result.instruction = '使用已有结构化结果继续用户任务。任务依赖图像时说明限制，避免重试截图。';
  }
  return { ...message, content: JSON.stringify(result) };
}

module.exports = { compactToolContent, omitToolImage };

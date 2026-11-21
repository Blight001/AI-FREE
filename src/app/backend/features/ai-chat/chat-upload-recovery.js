'use strict';

const { setTimeout: delay } = require('node:timers/promises');

const STATUS_ROLES = ['status', 'alert', 'progressbar'];
const OBSERVE_LIMIT = 16;
const OBSERVE_TIMEOUT_MS = 3000;
const UPLOAD_LABEL = /^(?:(?:file )?upload (?:status|receipt)|(?:文件)?上传(?:状态|回执))$/i;
const UPLOAD_PREFIX = /^(?:(?:file )?upload(?: status| receipt)?\b|(?:文件)?上传(?:状态|回执)?)[ :：]*/i;
/** @type {[RegExp, string][]} */
const STATES = [
  [/^(?:complete(?:d)?|successful|succeeded|confirmed|完成|成功|已确认)$/i, '上传完成'],
  [/^(?:failed|error|失败|出错)$/i, '上传失败'],
  [/^(?:pending|in progress|处理中|进行中|等待确认)$/i, '上传处理中'],
  [/^(?:unknown|unconfirmed|未知|未确认)$/i, '上传结果未知'],
];
const ASK_USER = '上传结果待核验。请在目标页面手动检查是否收到文件，确认前不要重复上传。';

function itemStatus(item) {
  if (!STATUS_ROLES.includes(item?.role) || item.textTruncated || item.editable) return '';
  const text = String(item.text ?? '').trim().replace(/[.!。…]+$/, '');
  const label = item.ariaLabel || item.label || '';
  // Keep only recognized status phrases. Labels, filenames and page text stay out of chat history.
  if (/^uploading$/i.test(text)) return '上传处理中';
  if (!UPLOAD_PREFIX.test(text) && !UPLOAD_LABEL.test(label)) return '';
  const value = text.replace(UPLOAD_PREFIX, '');
  return STATES.find(([pattern]) => pattern.test(value))?.[1] || '';
}

function observedStatus(result) {
  if (result?.success === false || result?.ok === false || !Array.isArray(result?.items)) return '';
  const statuses = new Set(result.items.slice(0, OBSERVE_LIMIT).map(itemStatus).filter(Boolean));
  return statuses.size === 1 ? statuses.values().next().value : '';
}

async function readUploadStatus(context, target) {
  if (!target?.connectionId || !target.pageToken || context.signal?.aborted) return '';
  const deadline = new AbortController();
  const signal = context.signal ? AbortSignal.any([context.signal, deadline.signal]) : deadline.signal;
  try {
    const observation = context.bridge.dispatch(target.connectionId, 'browser_observe', {
      surface: 'page', roles: STATUS_ROLES, limit: OBSERVE_LIMIT, text_limit: 80,
      mark: false, include_media: false, include_regions: false, include_screenshot: false,
    }, { expectedPageToken: target.pageToken, timeoutMs: OBSERVE_TIMEOUT_MS, allowAppSurface: false, signal });
    const timeout = delay(OBSERVE_TIMEOUT_MS, null, { signal });
    return observedStatus(await Promise.race([observation, timeout]));
  } catch (_) {
    return '';
  } finally {
    deadline.abort();
  }
}

async function recoverChatUpload(context, target, result) {
  if (result?.errorCode !== 'UPLOAD_OUTCOME_UNVERIFIED') return result;
  const status = await readUploadStatus(context, target);
  const error = status
    ? `上传结果待核验。目标页面显示「${status}」。请确认该状态是否对应本次文件，确认前不要重复上传。`
    : ASK_USER;
  if (context.uploadState) Object.assign(context.uploadState, { unverified: true, recoveryMessage: error });
  return { success: false, errorCode: result.errorCode, recoverable: false, error };
}

module.exports = { recoverChatUpload };

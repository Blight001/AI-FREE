'use strict';

function text(value) { return String(value == null ? '' : value).trim(); }

function finiteDimension(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function candidateLabel(item) {
  return text(item?.label || item?.ariaLabel || item?.alt || item?.text);
}

function candidateSize(item) {
  return { width: finiteDimension(item?.width), height: finiteDimension(item?.height) };
}

function mediaCandidate(item, observationId) {
  const ref = text(item?.id);
  if (!ref || text(item?.kind).toLowerCase() !== 'media') return null;
  const mediaUrl = text(item.mediaUrl || item.downloadUrl);
  const size = candidateSize(item);
  const hasPoint = [item.x, item.y, size.width, size.height].every(Number.isFinite);
  return {
    ref,
    observation_id: text(item.observationId || observationId),
    type: text(item.mediaType || item.tag || 'media'),
    tag: text(item.tag),
    label: candidateLabel(item),
    ...size,
    downloadable: Boolean(mediaUrl || text(item.selector) || hasPoint),
  };
}

async function browserMedia(owner, connection, args = {}) {
  const action = text(args.action || 'list').toLowerCase();
  if (action === 'list') {
    const observed = await owner.browserObserve(connection, {
      mode: 'elements', filter: 'media', include_media: true,
      include_text: args.include_text === true, limit: args.limit || 200,
      mark: args.mark === true,
    });
    if (observed?.success === false || observed?.ok === false) return observed;
    const media = (Array.isArray(observed.items) ? observed.items : [])
      .map((item) => mediaCandidate(item, observed.observationId)).filter(Boolean);
    return {
      success: true, action: 'list', observation_id: text(observed.observationId),
      url: text(observed.url), count: media.length, media,
    };
  }
  if (action === 'download') {
    const ref = text(args.ref || args.element);
    if (!ref) return {
      success: false, action, errorCode: 'MEDIA_REF_REQUIRED',
      error: 'browser_media 下载需要 list 返回的 ref，请先调用 action=list',
      suggestedAction: 'list', retryable: true,
    };
    return owner.browserFile(connection, {
      ...args, action: 'download_element', ref,
    });
  }
  return {
    success: false, action, errorCode: 'INVALID_MEDIA_ACTION',
    error: 'browser_media action 只支持 list 或 download', retryable: false,
  };
}

module.exports = { browserMedia };

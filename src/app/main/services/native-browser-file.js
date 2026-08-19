'use strict';

const path = require('path');
const { fileURLToPath } = require('url');
const {
  expiredObservedRefResult, mismatchedObservationResult,
} = require('./native-browser-observation');

function text(value) { return String(value == null ? '' : value).trim(); }

function observedRef(args = {}) {
  return text(args.ref || args.element || args.element_ref || args.elementRef);
}

function hasDownloadPoint(args = {}) {
  return Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y));
}

function localServerUploadPath(args = {}) {
  const direct = text(args.path);
  if (direct) return direct;
  const rawUrl = text(args.url);
  if (!/^file:/i.test(rawUrl)) throw new Error('upload_to_server 缺少 AI 工作区文件 path');
  try { return fileURLToPath(new URL(rawUrl)); } catch (_) {
    throw new Error('本地文件 URL 无效');
  }
}

function isDirectServerUpload(action, args = {}) {
  if (action === 'upload_to_server') return true;
  return action === 'download' && args.save_to_server === true && /^file:/i.test(text(args.url));
}

function resolvedFileAction(args = {}) {
  const action = text(args.action).toLowerCase();
  if (action !== 'download' || text(args.url)) return action;
  return observedRef(args) || hasDownloadPoint(args) ? 'download_element' : action;
}

function isDownloadElementUnavailable(value) {
  const code = text(value?.code || value?.errorCode);
  const message = text(value?.message || value?.error);
  return [
    'COMMAND_NOT_ALLOWED', 'IMAGE_ELEMENT_REQUIRED', 'IMAGE_URL_UNAVAILABLE',
    'ELEMENT_NOT_FOUND', 'TARGET_COORDINATE_INVALID',
  ].includes(code)
    || message.includes('Runtime Bridge 命令不在白名单')
    || message.includes('目标元素不是图片')
    || message.includes('没有可下载的 HTTP/HTTPS')
    || message.includes('未找到目标图片元素');
}

function clashProxyUrl() {
  try {
    const {
      getClashMiniStatus, getClashMiniProxyEndpoint, getClashMiniRuntimeRoot,
    } = require('../features/network/clash-mini-control-runtime');
    const status = getClashMiniStatus();
    if (status?.running !== true) return '';
    const coreDir = text(status.coreDir) || getClashMiniRuntimeRoot();
    const endpoint = coreDir ? getClashMiniProxyEndpoint(coreDir) : null;
    if (!endpoint || !Number.isFinite(Number(endpoint.port))) return '';
    return `http://${text(endpoint.host) || '127.0.0.1'}:${Number(endpoint.port)}`;
  } catch (_) {
    return '';
  }
}

function connectionProxyUrl(owner, connection) {
  const instance = owner.runtime?.chromium?.instances?.get(connection.profileId);
  const server = text(instance?.profile?.proxyServer);
  if (server) return server.includes('://') ? server : `http://${server}`;
  return clashProxyUrl();
}

function observedResourceUrl(input = {}, args = {}) {
  return text(args.url || input.mediaUrl || input.downloadUrl || input.resourceUrl);
}

function mediaHitAtPoint(items, point) {
  const matches = (Array.isArray(items) ? items : []).map((item) => {
    const url = text(item.mediaUrl || item.downloadUrl);
    const x = Number(item.x);
    const y = Number(item.y);
    const width = Number(item.width);
    const height = Number(item.height);
    const inside = url && [x, y, width, height].every(Number.isFinite)
      && point.x >= x && point.y >= y && point.x <= x + width && point.y <= y + height;
    return inside ? { mediaUrl: url, downloadUrl: text(item.downloadUrl || url), mediaType: text(item.mediaType) } : null;
  }).filter(Boolean);
  return matches[0] || null;
}

async function locateMediaResource(owner, connection, input, args) {
  const known = observedResourceUrl(input, args);
  if (known) return { url: known, mediaType: input.mediaType };
  if (!hasDownloadPoint(input)) return { url: '', mediaType: '' };
  const observed = await owner.runtimeCommand(connection, 'observe-page', {
    filter: 'media', includeMedia: true, showHighlights: false, limit: 200,
  });
  const hit = mediaHitAtPoint(observed?.items, input);
  return { url: text(hit?.mediaUrl), mediaType: text(hit?.mediaType) };
}

async function pageSession(owner, connection) {
  const response = await owner.runtimeCommand(connection, 'get-session-data', {});
  const session = response?.result || response || {};
  return { pageUrl: text(session.url), cookies: Array.isArray(session.cookies) ? session.cookies : [] };
}

async function softwareDownload(owner, connection, args, sourceUrl, extras = {}) {
  if (!owner.downloadService?.execute) throw new Error('AI 工作区下载服务不可用');
  const session = await pageSession(owner, connection);
  return owner.downloadService.execute({
    ...args,
    action: 'download',
    url: sourceUrl,
    page_url: session.pageUrl,
    referer: session.pageUrl,
    cookies: args.use_cookies === false ? [] : session.cookies,
    proxy_url: extras.proxyUrl ?? connectionProxyUrl(owner, connection),
    media_type: args.media_type || extras.mediaType || 'image',
  }, { pageUrl: session.pageUrl });
}

async function resolveFileTarget(owner, connection, args) {
  const ref = observedRef(args);
  const input = owner.resolveObservedTarget(connection, ref && !text(args.ref) ? { ...args, ref } : args);
  return input.observedRefRecoveryCandidate
    ? owner.recoverObservedTarget(connection, input)
    : input;
}

async function downloadObservedResource(owner, connection, input, args, cause) {
  const located = await locateMediaResource(owner, connection, input, args);
  if (!located.url) {
    const detail = text(cause?.message || cause?.error || '无法从页面元素解析可下载地址');
    throw new Error(`${detail}。请重新调用 browser_observe filter=media 后使用最新 ref，或传入图片 URL`);
  }
  return softwareDownload(owner, connection, args, located.url, {
    mediaType: located.mediaType || input.mediaType,
  });
}

async function nativeElementDownload(owner, connection, target, args) {
  return owner.downloadService.downloadElement(args, (targetPath) => owner.runtimeCommand(
    connection, 'download-element', { ...target, target_path: targetPath },
  ));
}

async function browserDownloadElement(owner, connection, args) {
  if (!owner.downloadService?.downloadElement) throw new Error('Chromium 元素下载服务不可用');
  const input = await resolveFileTarget(owner, connection, args);
  const mismatch = mismatchedObservationResult(input);
  if (mismatch) return mismatch;
  const expired = expiredObservedRefResult(input);
  if (expired) return expired;
  const target = owner.runtimeTarget(input);
  const canNative = text(target.selector) || hasDownloadPoint(target);
  try {
    if (!canNative) return downloadObservedResource(owner, connection, input, args);
    const result = await nativeElementDownload(owner, connection, target, args);
    if (result?.success === false && isDownloadElementUnavailable(result)) {
      return downloadObservedResource(owner, connection, input, args, result);
    }
    return result;
  } catch (error) {
    if (!isDownloadElementUnavailable(error)) throw error;
    return downloadObservedResource(owner, connection, input, args, error);
  }
}

async function browserDownloadUrl(owner, connection, args) {
  const transport = text(args.transport || 'auto').toLowerCase();
  if (transport === 'browser' || (transport === 'auto' && (observedRef(args) || hasDownloadPoint(args)))) {
    try {
      return await browserDownloadElement(owner, connection, { ...args, action: 'download_element' });
    } catch (error) {
      if (transport === 'browser' || !isDownloadElementUnavailable(error)) throw error;
    }
  }
  return softwareDownload(owner, connection, args, args.url, { mediaType: args.media_type });
}

async function browserUpload(owner, connection, args) {
  const input = owner.runtimeTarget(owner.resolveObservedTarget(
    connection, { ...args, action: 'upload_file' },
  ));
  if (!owner.downloadService?.resolveUploadPaths) throw new Error('AI 工作区文件服务不可用');
  const requested = Array.isArray(args.paths) ? args.paths : [args.path].filter(Boolean);
  const paths = owner.downloadService.resolveUploadPaths(requested);
  const mode = text(args.mode) || (paths.length > 1 ? 'open-multiple' : 'open');
  const session = text(args.page_url || args.pageUrl)
    ? null
    : await owner.runtimeCommand(connection, 'get-session-data', {});
  await owner.runtime.selectFilesByProcessId(connection.browserProcessId, {
    pageUrl: text(args.page_url || args.pageUrl || session?.url), paths, mode, ttlMs: 5000,
  });
  return owner.runtimeCommand(connection, 'perform-action', input);
}

function browserServerUpload(owner, args) {
  if (!owner.downloadService?.resolveUploadPaths) throw new Error('AI 工作区文件服务不可用');
  const [absolutePath] = owner.downloadService.resolveUploadPaths([localServerUploadPath(args)]);
  return {
    success: true, action: 'upload_to_server', file_name: path.basename(absolutePath),
    absolute_path: absolutePath, local_workspace_file: true,
  };
}

async function browserFile(owner, connection, args) {
  const action = resolvedFileAction(args);
  if (isDirectServerUpload(action, args)) return browserServerUpload(owner, args);
  if (action === 'upload') return { ...(await browserUpload(owner, connection, args)), action: 'upload' };
  if (action === 'download_element') return browserDownloadElement(owner, connection, args);
  if (!owner.downloadService?.execute) throw new Error('AI 工作区下载服务不可用');
  if (action === 'download') return browserDownloadUrl(owner, connection, args);
  if (action !== 'save_session') return owner.downloadService.execute(args);
  const response = await owner.runtimeCommand(connection, 'get-session-data', {});
  return owner.downloadService.execute({ ...args, session: response?.result || response });
}

module.exports = {
  browserFile,
  connectionProxyUrl,
  isDirectServerUpload,
  isDownloadElementUnavailable,
  localServerUploadPath,
  observedRef,
  resolvedFileAction,
};

'use strict';

const path = require('node:path');
const { CONFIRMED_UPLOAD_FILES } = require('../../browser-runtime/chromium-upload-staging');
const { inspectWorkspaceFileSync, verifyWorkspaceArtifactSync } = require('./ai-workspace-service');
const { captureChatTarget, confirmBrowserUpload, routeFailure } = require('./chat-browser-target');

function uploadSnapshot(context, args) {
  const { workspaceDir, artifactReferences = [], artifacts = [] } = context;
  const knownArtifacts = [...artifacts].reverse().concat(artifactReferences);
  const requested = Array.isArray(args.paths) ? args.paths : [args.path].filter(Boolean);
  if (!workspaceDir || !requested.length || requested.length > 16) throw new Error('无效的上传文件列表');
  return requested.map((file) => {
    if (typeof file !== 'string') throw new Error('无效的上传文件路径');
    const relative = path.isAbsolute(file) ? path.relative(workspaceDir, file) : file;
    const key = (value) => value.replaceAll('\\', '/').toLowerCase();
    const artifact = knownArtifacts.find((item) => key(item.path) === key(relative));
    return artifact ? verifyWorkspaceArtifactSync(workspaceDir, artifact) : inspectWorkspaceFileSync(workspaceDir, relative);
  });
}

function uploadUnverified(context) {
  if (context.uploadState) context.uploadState.unverified = true;
  return { success: false, errorCode: 'UPLOAD_OUTCOME_UNVERIFIED', recoverable: false,
    error: '上传结果待核验。请先检查目标页面是否收到文件，不要重复上传。' };
}

async function prepareUpload(context, connectionId, args) {
  const target = await captureChatTarget(context.bridge, connectionId);
  if (!target.ok || target.data.pageToken !== context.boundTarget.pageToken) {
    return routeFailure('BROWSER_TARGET_CHANGED', '目标页面已变化，请重新核对目标标签和文件');
  }
  const files = uploadSnapshot(context, args);
  const confirmed = files.every((file) => file.isRasterImage)
    || await confirmBrowserUpload({ ...context, boundTarget: target.data }, files.map((file) => file.path));
  if (!confirmed) {
    if (context.uploadState) context.uploadState.declined = true;
    return routeFailure('UPLOAD_NOT_CONFIRMED', '未确认上传，操作没有执行');
  }
  const currentFiles = uploadSnapshot(context, args);
  if (JSON.stringify(currentFiles) !== JSON.stringify(files)) {
    return routeFailure('UPLOAD_FILE_CHANGED', '待上传文件已变化，请重新选择');
  }
  const { path: _path, pageUrl: _pageUrl, page_url: _page_url, ...operation } = args;
  return { ...operation, paths: files.map((file) => file.absolutePath), [CONFIRMED_UPLOAD_FILES]: files };
}

async function dispatchChatUpload(context, connectionId, args, dispatch) {
  if (context.uploadState?.declined) return routeFailure('UPLOAD_NOT_CONFIRMED', '本轮上传已取消');
  let operation;
  try { operation = await prepareUpload(context, connectionId, args); }
  catch (_) { return routeFailure('UPLOAD_NOT_READY', '无法验证上传目标或工作区文件，请检查目标标签和所选文件'); }
  if (operation.success === false) return operation;
  if (context.signal?.aborted) return routeFailure('UPLOAD_NOT_CONFIRMED', '上传已取消');
  try {
    const result = await dispatch(operation);
    if (result?.success === true || result?.ok === true) {
      return { ...result, uploadVerification: 'file_selected',
        message: '文件已交给页面文件控件；站点是否接收需要另外检查。' };
    }
    return result?.actionExecuted === false ? result : uploadUnverified(context);
  } catch (_) { return uploadUnverified(context); }
}

module.exports = { dispatchChatUpload };

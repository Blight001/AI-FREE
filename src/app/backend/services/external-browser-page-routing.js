'use strict';

const { isBrowserNavigationWait } = require('./automation-tool-contract');
const { resolvedFileAction } = require('./native-browser-file');
const { bindingFailure, isPageBoundFileAction } = require('./native-browser-page-binding');

function usesPageBinding(tool, args, fileAction) {
  // Session data must never fall through to an unbound read, even for a non-page surface.
  if (fileAction === 'save_session') return true;
  if (args.surface && args.surface !== 'page') return false;
  if (['browser_observe', 'browser_media', 'browser_screenshot', 'browser_action', 'browser_page_batch'].includes(tool)) return true;
  if (tool === 'browser_wait') return !isBrowserNavigationWait(tool, args);
  return isPageBoundFileAction(fileAction);
}

async function dispatchExternalBrowserTool(dispatch, connectionId, tool, args, options) {
  // Keep the public reference namespace stable within each entry. A fresh
  // external observe must not replace the sidebar's latest references.
  const scoped = { ...options, externalObservations: true };
  const fileAction = tool === 'browser_file' ? resolvedFileAction(args) : undefined;
  if (!usesPageBinding(tool, args, fileAction)) return dispatch(connectionId, tool, args, scoped);
  const tabs = await dispatch(connectionId, 'browser_tab', { action: 'list' }, scoped);
  if (tabs?.success === false) return tabs;
  const token = tabs?.activeTab?.pageToken;
  // Both first-party entries carry a trusted document token to the same page executor.
  // Legacy runtimes without document identity retain their original external contract.
  if (!token && fileAction === 'save_session' && tabs?.activeTab) {
    return bindingFailure('BROWSER_TARGET_UNAVAILABLE', '无法识别当前页面，请确认标签已加载并使用支持页面校验的内核');
  }
  if (!token && !tabs?.activeTab) {
    return bindingFailure('BROWSER_TARGET_REQUIRED', '无法取得活动标签，请先选择已加载的页面');
  }
  return dispatch(connectionId, tool, args, token ? { ...scoped, expectedPageToken: token } : scoped);
}

module.exports = { dispatchExternalBrowserTool };

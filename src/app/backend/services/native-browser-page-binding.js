'use strict';

const PAGE_TOKEN = Symbol('trusted-page-token');
const TOOLS = new Set(['browser_observe', 'browser_screenshot', 'browser_action', 'browser_wait']);

function expectedPageToken(connection) { return connection[PAGE_TOKEN]; }

function bindPage(connection, token) { return { ...connection, [PAGE_TOKEN]: token }; }

function bindingFailure(errorCode, error) { return { success: false, errorCode, error, retryable: false }; }

function boundToolFailure(tool, input, fileAction) {
  const action = String(input.action || '').trim().toLowerCase();
  const supported = TOOLS.has(tool)
    || (tool === 'browser_control' && action === 'acquire')
    || (tool === 'browser_media' && ['', 'list', 'download'].includes(action))
    || (tool === 'browser_file' && ['download_element', 'upload'].includes(fileAction));
  if (supported && (!input.surface || input.surface === 'page')) return null;
  return bindingFailure('BROWSER_TARGET_TOOL_UNSUPPORTED', '此操作无法限定在已绑定的页面');
}

function runtimeBindingFailure(error) {
  if (!['BROWSER_TARGET_CHANGED', 'BROWSER_TARGET_REQUIRED', 'BROWSER_RUNTIME_UPDATE_REQUIRED'].includes(error?.code)) throw error;
  return bindingFailure(error.code, error.message);
}

module.exports = { PAGE_TOKEN, bindPage, bindingFailure, boundToolFailure, expectedPageToken, runtimeBindingFailure };

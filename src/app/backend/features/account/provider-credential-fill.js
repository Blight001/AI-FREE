'use strict';

const { AppError } = require('../../../contracts/ipc-result');

function httpsOrigin(value) {
  const url = URL.parse(value);
  return url?.protocol === 'https:' && !url.username && !url.password ? url.origin : '';
}

function credentialSelector(input) {
  const { field, field_id: id, field_name: name } = input;
  const type = field === 'password' ? '[type="password" i]' : ':is([type="text" i],[type="email" i],:not([type]))';
  const locator = id || name;
  if (!/^[\w.:-]{1,128}$/.test(locator || '') || Boolean(id) === Boolean(name)) {
    throw new AppError('ACCOUNT_FIELD_REQUIRED', '必须指定唯一的输入框 ID 或 name');
  }
  return `input[${id ? 'id' : 'name'}="${locator}"]${type}:not([readonly]):not(:disabled)`;
}

async function resolveFillTarget(bridge, input, signal) {
  const origin = httpsOrigin(input.origin);
  if (!origin || ![origin, `${origin}/`].includes(input.origin)) {
    throw new AppError('ACCOUNT_ORIGIN_REQUIRED', '请提供目标页面的 HTTPS 源，包含协议、主机及非默认端口');
  }
  const connection = bridge.getConnection(input.change_browser);
  if (!connection?.browserProcessId) throw new AppError('ACCOUNT_BROWSER_REQUIRED', '请使用已连接的浏览器 ID');
  const result = await bridge.dispatch(connection.id, 'browser_tab', { action: 'list' }, { signal, timeoutMs: 5000 });
  const page = result?.activeTab;
  if (!page?.pageToken || httpsOrigin(page.url) !== origin) {
    throw new AppError('ACCOUNT_TARGET_MISMATCH', '活动页面与指定网站不一致，或浏览器内核不支持页面绑定');
  }
  return { connection, origin, pageToken: page.pageToken };
}

const fillErrors = {
  BROWSER_TARGET_CHANGED: ['ACCOUNT_TARGET_CHANGED', '页面已变更，请重新核对后再填写'],
  BROWSER_RUNTIME_UPDATE_REQUIRED: ['BROWSER_RUNTIME_UPDATE_REQUIRED', '请更新 Chromium 内核以使用账号填充'],
  BROWSER_TAKEOVER_REQUIRED: ['BROWSER_TAKEOVER_REQUIRED', '请先接管目标网页'],
};

async function applyFill(runtime, target, input, signal) {
  let code;
  try {
    const reply = await runtime.dispatchAutomationByProcessId(
      target.connection.browserProcessId, 'fill-account-field', input,
      { expectedPageToken: target.pageToken, signal },
    );
    const result = reply?.result;
    if (result?.success === true && result.filled === true) return { filled: true };
    code = result?.errorCode;
  } catch (error) {
    code = error?.code;
  }
  const [errorCode, message] = Object.hasOwn(fillErrors, code) ? fillErrors[code]
    : ['ACCOUNT_FILL_FAILED', '未能填写，请确认主页面的输入框唯一、可见且可编辑'];
  throw new AppError(errorCode, message);
}

async function fillProviderCredential({ vault, bridge, runtime }, input, signal = undefined) {
  const selector = credentialSelector(input);
  const target = await resolveFillTarget(bridge, input, signal);
  signal?.throwIfAborted();
  const credentials = vault.getCredentials(input.provider, input.id);
  const value = input.field === 'password' ? credentials.password : credentials.email;
  return applyFill(runtime, target, { origin: target.origin, selector, field: input.field, value }, signal);
}

module.exports = { fillProviderCredential };

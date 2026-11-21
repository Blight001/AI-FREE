'use strict';

const GUARDED_COMMANDS = new Set([
  'observe-page', 'capture-screenshot', 'perform-action', 'download-element',
  'automation-takeover', 'select-files',
]);

async function sendPageCommand(client, command, payload, options, expectedPageToken) {
  if (expectedPageToken === undefined) return options ? client.send(command, payload, options) : client.send(command, payload);
  if (typeof expectedPageToken !== 'string' || !expectedPageToken.trim() || expectedPageToken.length > 256) {
    throw Object.assign(new Error('Invalid page binding'), { code: 'BROWSER_TARGET_REQUIRED' });
  }
  if (!GUARDED_COMMANDS.has(command)) {
    throw Object.assign(new Error('Command does not support page binding'), { code: 'BROWSER_TARGET_TOOL_UNSUPPORTED' });
  }
  try {
    // Old kernels reject the envelope instead of ignoring an optional field.
    return await client.send('page-bound-command', { expectedPageToken, command, payload }, options);
  } catch (error) {
    if (error.code !== 'COMMAND_NOT_ALLOWED') throw error;
    throw Object.assign(new Error('当前 Chromium 内核不支持原子页面绑定'), { code: 'BROWSER_RUNTIME_UPDATE_REQUIRED' });
  }
}

module.exports = { sendPageCommand };

'use strict';

const { needsBrowserAdmission } = require('./automation-card-contract');
const { isBrowserOverview } = require('./automation-tool-contract');

async function dispatchAutomationMcpShortcut(options) {
  const { toolName, args, signal } = options;
  if (isBrowserOverview(toolName, args) && options.getBrowserOverview) {
    return { handled: true, result: options.getBrowserOverview(options.sanitizeArgs(args)) };
  }
  if (!isLocalCardAction(toolName, args)) return { handled: false };
  if (typeof options.manageCard !== 'function') throw new Error('自动化卡片服务不可用');
  return { handled: true, result: await options.manageCard(options.sanitizeArgs(args), signal) };
}

function isLocalCardAction(toolName, args) {
  const action = String(args.action || '').trim().toLowerCase();
  return toolName === 'manage_card' && !needsBrowserAdmission(action);
}

module.exports = { dispatchAutomationMcpShortcut };

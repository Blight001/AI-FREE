'use strict';

const { createAiBrowserWindowTools } = require('../../services/ai-browser-window-tools');
const { createAiSandboxFileTools, RUN_COMMAND_TOOL_NAME } = require('../../services/ai-sandbox-file-tools');
const { createProviderAccountTools } = require('../account/provider-account-tools');
const { createProviderAccountUi } = require('../account/provider-account-ui');
const { combineToolSets } = require('../../services/combine-tool-sets');
const { createChatRunRegistry } = require('./chat-run-registry');
const { prepareChatContinuation, prepareChatRequest } = require('./chat-request-context');
const { runChatConversation } = require('./chat-conversation-runner');
const { addChatQuotaUsed } = require('../../../shared/quota-display');
const { isChatStopped } = require('./chat-execution-state');
const { enrichBrowserConnectionNames } = require('./connection-names');

function namedBrowserConnections(deps) {
  const bridge = deps.browserAutomationBridge;
  const connections = (bridge?.listConnections?.() || [])
    .map((item) => bridge.getConnection?.(item.id))
    .filter(Boolean);
  return enrichBrowserConnectionNames(
    connections,
    typeof deps.getTabs === 'function' ? deps.getTabs() : [],
    deps.browserRuntimeManager?.listStates?.() || [],
  );
}

async function waitForBrowserConnection(deps, target = {}, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  const wantedName = String(target.name || '').trim().toLowerCase();
  const wantedProfile = String(target.tabId || target.profileId || '').trim();
  do {
    const found = namedBrowserConnections(deps).find((item) => (
      (wantedProfile && String(item.profileId || '') === wantedProfile)
      || (wantedName && String(item.name || '').trim().toLowerCase() === wantedName)
    ));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return null;
}

function buildAccountTools(deps, fileTools) {
  if (!deps.providerAccountVault) return null;
  const ui = createProviderAccountUi({
    getMainWindow: deps.getMainWindow,
    revealMainWindow: deps.revealMainWindow,
    switchTab: deps.browserWindowUi.switchTab,
    dialog: deps.dialog,
  });
  return createProviderAccountTools({
    vault: deps.providerAccountVault,
    bridge: deps.browserAutomationBridge,
    runtime: deps.browserRuntimeManager,
    runImportCommand: (args, options) => fileTools.execute(RUN_COMMAND_TOOL_NAME, args, options),
    ...ui,
  });
}

function createAiChatService(deps = {}) {
  const {
    licenseCache,
    logger = console,
  } = deps;
    const chatRuns = createChatRunRegistry();

    // 软件端默认的“外层”浏览器窗口控制工具与 Chromium 原生连接分别管理窗口和页面，
    // 每次对话都会注入，让 AI 能列出/打开/新建/重命名/关闭软件的浏览器窗口。
    let aiBrowserWindowTools = null;
    const getAiBrowserWindowTools = () => {
      if (aiBrowserWindowTools) return aiBrowserWindowTools;
      if (!deps.browserWindowUi) return null;
      try {
        const windowTools = createAiBrowserWindowTools({
          ui: deps.browserWindowUi,
          licenseCache,
          logger,
          waitForBrowserConnection: (target) => waitForBrowserConnection(deps, target),
        });
        const fileTools = createAiSandboxFileTools({ sandboxDir: deps.aiSandboxDir });
        const accountTools = buildAccountTools(deps, fileTools);
        aiBrowserWindowTools = combineToolSets(windowTools, fileTools, accountTools);
      } catch (error) {
        logger.warn?.('[AI窗口工具] 初始化失败:', error?.message || error);
      }
      return aiBrowserWindowTools;
    };

    async function insert(_event, input = {}) {
      const requestId = String(input.requestId || '').trim();
      const content = String(input.content || '').trim();
      if (!requestId || !content) return { ok: false, message: '缺少要插入的对话内容' };
      return chatRuns.insert(_event, requestId, content);
    }

    async function stop(_event, input = {}) {
      const requestId = String(input.requestId || '').trim();
      return chatRuns.stop(_event, requestId);
    }

    async function chat(_event, input = {}) {
      const getWindowTools = () => combineToolSets(getAiBrowserWindowTools(), deps.getParentChatTools?.(_event, input));
      let activeRun = null;
      let activeRunKey = '';
      let quotaUsed = 0;
      try {
        const request = input.resumeRequestId
          ? prepareChatContinuation(deps, _event, input, chatRuns)
          : prepareChatRequest(deps, _event, input, chatRuns, getWindowTools);
        activeRunKey = request.runKey || '';
        activeRun = request.run || null;
        if (request.error) return request.error;
        // A resumed invocation reports only the new charges from this invocation.
        request.onQuotaUsed = (amount) => { quotaUsed = addChatQuotaUsed(quotaUsed, amount); };
        const result = await runChatConversation(request);
        const settled = { ...result, quotaUsed };
        if (result.stopped && chatRuns.saveContinuation(_event, activeRunKey, activeRun)) {
          return { ...settled, resumable: true };
        }
        return settled;
      } catch (error) {
        if (isChatStopped(activeRun, error)) {
          return { ok: true, stopped: true, quotaUsed, messages: [], message: { role: 'assistant', content: '' } };
        }
        return { ok: false, quotaUsed, message: error?.message || String(error) };
      } finally {
        chatRuns.finish(activeRunKey, activeRun);
      }
    }

    return {
      chat, getWindowTools: getAiBrowserWindowTools, insert, stop,
    };
}

module.exports = { createAiChatService, namedBrowserConnections, waitForBrowserConnection };

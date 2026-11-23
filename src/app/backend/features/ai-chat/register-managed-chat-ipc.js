'use strict';

const { createHash } = require('node:crypto');
const { AppError, fail } = require('../../../contracts/ipc-result');
const { normalizeAccountSession } = require('../../utils/account-session');
const { CHAT_SESSION_TOOL, chatSessionDefinition } = require('./managed-chat-contract');
const { createManagedChatRunner } = require('./managed-chat-runner');
const { createManagedChatService } = require('./managed-chat-service');

function sidebarMainFrame(event, sidebar) {
  return Boolean(sidebar && !sidebar.isDestroyed?.() && event.sender === sidebar && event.senderFrame === sidebar.mainFrame);
}

function getManagedAccount(readStoreConfigSafe) {
  const { authenticated, serverBase, username, deviceId } = normalizeAccountSession(readStoreConfigSafe()?.userCredentials);
  return authenticated ? createHash('sha256').update(JSON.stringify([serverBase, username, deviceId])).digest('hex') : '';
}

function managedToolSet(service, fixedActor = '', parentId = '') {
  return {
    tools: [chatSessionDefinition],
    has: (name) => name === CHAT_SESSION_TOOL,
    async execute(_name, args, options = /** @type {any} */ ({})) {
      const actor = fixedActor || options.managedChatActor || 'local';
      const response = await service.execute({ actor, parentId }, args, options.signal);
      if (actor.startsWith('card:') && response.ok && ['send', 'wait', 'resume'].includes(args.action)) {
        const runs = response.data.runs || [response.data];
        if (runs.some((item) => item.status !== 'completed')) {
          return fail(new AppError('CHAT_CARD_INCOMPLETE', '子对话尚未完成，自动化步骤已停止', {
            details: runs.map(({ sessionId, runId, status }) => ({ sessionId, runId, status })),
          }));
        }
      }
      return response;
    },
  };
}

function registerManagedChatIpc({ ipc, deps, getModels }) {
  const getSidebar = () => deps.getSideView?.()?.webContents;
  const getAccount = () => getManagedAccount(deps.readStoreConfigSafe);
  const service = createManagedChatService({
    repository: deps.managedChatRepository, getModels, getAccount, run: createManagedChatRunner(deps),
    onChange: (sessionId, parentId, account) => {
      if (getAccount() !== account) return;
      const sidebar = getSidebar();
      if (sidebar && !sidebar.isDestroyed?.()) sidebar.send('ai-control-managed-chat-changed', { sessionId, parentId });
    },
  });
  const dispose = ipc.handle('ai-control-managed-chat', (event, input) => {
    if (!sidebarMainFrame(event, getSidebar())) return fail(new AppError('FORBIDDEN', '仅 AI 控制侧栏可以管理子会话'));
    return service.execute({ actor: 'sidebar' }, input);
  });
  return {
    dispose: () => { dispose(); service.dispose(); },
    getExternalTools: () => managedToolSet(service),
    getParentTools: (event, input) => input.localInteraction === true && input.parentSessionId && sidebarMainFrame(event, getSidebar())
      ? managedToolSet(service, `parent:${input.parentSessionId}`, input.parentSessionId) : null,
  };
}

module.exports = { managedToolSet, registerManagedChatIpc };

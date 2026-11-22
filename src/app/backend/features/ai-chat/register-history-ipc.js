'use strict';

const { AppError, wrapIpcResult } = require('../../../contracts/ipc-result');

function registerAiHistoryIpc({ ipc, historyRepository, getCredentials, getSidebar }) {
  ipc.handle('ai-control-history-list', async () => {
    try {
      return historyRepository.listSessions(getCredentials());
    } catch (error) {
      return { ok: false, message: error?.message || String(error), sessions: [] };
    }
  });

  ipc.handle('ai-control-history-get', async (_event, input = {}) => {
    try {
      return historyRepository.getSession(getCredentials(), input?.id);
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  });

  ipc.handle('ai-control-history-save', async (_event, input = {}) => {
    try {
      return historyRepository.saveSession(getCredentials(), input?.session || input || {}, {
        setCurrent: input?.setCurrent !== false,
      });
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  });

  ipc.handle('ai-control-history-delete', async (_event, input = {}) => {
    try {
      return historyRepository.deleteSession(getCredentials(), input?.id);
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  });

  ipc.handle('ai-control-history-rename', async (_event, input = {}) => {
    try {
      return historyRepository.renameSession(getCredentials(), input?.id, input?.title);
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  });

  ipc.handle('ai-control-history-create', async (_event, input = {}) => {
    try {
      return historyRepository.createSession(getCredentials(), input || {});
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  });
  return ipc.handle('ai-control-history-pin', wrapIpcResult((event, { id, pinned }) => {
    const sidebar = getSidebar?.();
    if (!sidebar || sidebar.isDestroyed?.() || event.sender !== sidebar || event.senderFrame !== sidebar.mainFrame) {
      throw new AppError('FORBIDDEN', '仅 AI 控制侧栏可以设置对话置顶');
    }
    return historyRepository.setSessionPinned(getCredentials(), id, pinned);
  }, { fallbackCode: 'AI_HISTORY_PIN_WRITE_FAILED' }));
}

module.exports = { registerAiHistoryIpc };

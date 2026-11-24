  function applySession(session) {
    state.pausedChat = null;
    state.currentSession = session || null;
    state.childQuota = null;
    renderConversationQuotaUsed();
    if (typeof refreshManagedParent === 'function') void refreshManagedParent();
    state.modelSelectionFromHistory = Boolean(session);
    state.messages = Array.isArray(session?.messages) ? [...session.messages] : [];
    const modelSelect = el('ai-chat-model');
    if (modelSelect && session?.modelId) {
      const hasModel = Array.from(modelSelect.options).some((opt) => opt.value === session.modelId);
      if (hasModel) {
        modelSelect.value = session.modelId;
        syncSelectUi(modelSelect);
      }
    }
    updateSessionTitleUi();
    renderConversation();
    resetAiChatScroll();
    renderHistoryList();
    syncSendState();
  }

  function shouldSaveBeforeSessionSwitch(sessionId, options) {
    return !options.skipSaveCurrent
      && Boolean(currentMessages().length)
      && Boolean(state.currentSession?.id)
      && state.currentSession.id !== sessionId;
  }

  async function loadRemoteHistorySession(sessionId, options = {}) {
    const historyGet = window.aiFree?.ai?.historyGet;
    if (!historyGet) return null;
    const result = await historyGet({ id: sessionId, setCurrent: options.setCurrent !== false });
    if (result?.ok && result.session) return result.session;
    if (result?.ok === false) throw new Error(result.message || '对话不存在');
    return null;
  }

  async function loadSessionById(sessionId, options = {}) {
    if (!sessionId || state.loading) return false;
    try {
      // 切换前先保存当前
      if (shouldSaveBeforeSessionSwitch(sessionId, options)) {
        await persistCurrentSession();
      }
      const session = await loadRemoteHistorySession(sessionId);
      if (!session) throw new Error('对话不存在');
      applySession(session);
      closeAllSelects();
      el('ai-chat-input')?.focus();
      return true;
    } catch (error) {
      setStatus(error?.message || String(error), 'warning');
      return false;
    }
  }

  async function deleteRemoteHistorySession(sessionId) {
    const historyDelete = window.aiFree?.ai?.historyDelete;
    if (!historyDelete) return { nextCurrentId: '', sessions: null };
    const result = await historyDelete({ id: sessionId });
    if (!result?.ok && result?.message && result.message !== '对话不存在') throw new Error(result.message);
    if (!result?.ok) return { nextCurrentId: '', sessions: null };
    return {
      nextCurrentId: String(result.currentId || ''),
      sessions: Array.isArray(result.sessions) ? result.sessions : [],
    };
  }

  async function selectSessionAfterDelete(sessionId, nextCurrentId) {
    if (state.currentSession?.id !== sessionId) {
      renderHistoryList();
      return;
    }
    state.currentSession = null;
    state.messages = [];
    if (nextCurrentId && nextCurrentId !== sessionId) {
      const loaded = await loadSessionById(nextCurrentId, { skipSaveCurrent: true });
      if (loaded) return;
    }
    await startNewConversation({ skipSave: true });
  }

  async function performDeleteSessionById(sessionId) {
    try {
      const remote = await deleteRemoteHistorySession(sessionId);
      const localStore = deleteLocalSession(sessionId);
      const nextCurrentId = remote.nextCurrentId || String(localStore.currentId || '');

      if (remote.sessions) {
        state.sessionList = mergeSessionLists(remote.sessions, localStore.sessions.map(sessionSummaryLocal));
      } else {
        await refreshHistoryList();
      }
      await selectSessionAfterDelete(sessionId, nextCurrentId);
      setStatus('对话已删除', 'success');
    } catch (error) {
      setStatus(error?.message || String(error), 'warning');
    }
  }

  async function renameRemoteHistorySession(sessionId, title) {
    const historyRename = window.aiFree?.ai?.historyRename;
    if (!historyRename) return null;
    const result = await historyRename({ id: sessionId, title });
    if (!result?.ok && result?.message && result.message !== '对话不存在') throw new Error(result.message);
    return result?.ok ? result.session || null : null;
  }

  async function performRenameSessionById(sessionId, requestedTitle) {
    const title = String(requestedTitle || '').trim().slice(0, 40);
    if (!title) {
      setStatus('对话名称不能为空', 'warning');
      return;
    }

    const remoteSession = await renameRemoteHistorySession(sessionId, title);

    const localSession = renameLocalSession(sessionId, title);
    if (!remoteSession && !localSession) throw new Error('对话不存在');

    if (String(state.currentSession?.id || '') === String(sessionId)) {
      state.currentSession.title = title;
      state.currentSession.titleGenerated = true;
      updateSessionTitleUi();
    }
    await refreshHistoryList();
    setStatus('对话已重命名', 'success');
  }

  function canGenerateSessionTitle(session, modelId) {
    if (!session || session.titleGenerated || state.generatingTitle) return false;
    if (!selectedModelIsCustom() && isQuotaExhausted()) return false;
    return Boolean(modelId && window.aiFree?.ai?.chat);
  }

  function findTitleMessages() {
    return {
      user: currentMessages().find((message) => message.role === 'user' && String(message.content || '').trim()),
      assistant: currentMessages().find((message) => message.role === 'assistant' && String(message.content || '').trim()),
    };
  }

  async function ensureProvisionalSessionTitle(session, userMessage) {
    if (session.title && session.title !== '新对话') return;
    session.title = provisionalTitle(userMessage.content);
    updateSessionTitleUi();
    await persistCurrentSession({ title: session.title, titleGenerated: false });
  }

  async function requestGeneratedSessionTitle(modelId, messages) {
    return window.aiFree.ai.chat({
      modelId,
      quota: state.quota,
      disableTools: true,
      browserConnectionId: '',
      messages: [
        {
          role: 'system',
          content: '你是标题生成助手。根据对话内容生成一个简短中文标题。要求：不超过16个字，不要引号、标点装饰和解释，只输出标题本身。',
        },
        {
          role: 'user',
          content: `用户：${String(messages.user.content).slice(0, 240)}\n助手：${String(messages.assistant.content).slice(0, 240)}\n请生成标题：`,
        },
      ],
    });
  }

  async function applyGeneratedSessionTitle(sessionId, result) {
    if (result?.quota) renderQuota(result.quota);
    const isCurrent = state.currentSession?.id === sessionId;
    const session = isCurrent
      ? state.currentSession
      : await loadRemoteHistorySession(sessionId, { setCurrent: false });
    if (!session) return;
    const title = result?.ok && !session.titleGenerated ? sanitizeGeneratedTitle(result.message?.content) : '';
    if (!title && !(result?.quotaUsed > 0)) return;
    session.quotaUsed = window.AiFreeQuotaDisplay.addChatQuotaUsed(session.quotaUsed, result.quotaUsed);
    if (title) Object.assign(session, { title, titleGenerated: true });
    if (isCurrent) {
      renderConversationQuotaUsed();
      await persistCurrentSession();
    } else {
      upsertLocalSession(session, false);
      await saveSessionToMain(session, false);
      await refreshHistoryList();
    }
  }

  function renameSessionById(sessionId) {
    if (!sessionId) return;
    const session = state.sessionList.find((item) => String(item.id) === String(sessionId));
    const currentTitle = String(session?.title || state.currentSession?.title || '新对话');
    closeSelect(el('ai-chat-history-select'));
    const modal = window.MessageModal;
    if (!modal?.showPromptDialog) {
      setStatus('重命名弹窗尚未就绪，请稍后重试', 'warning');
      return;
    }
    modal.showPromptDialog(
      '请输入新的对话名称',
      currentTitle,
      (title) => performRenameSessionById(sessionId, title),
      null,
      {
        title: '重命名对话',
        confirmText: '保存',
        maxLength: 40,
        placeholder: '对话名称',
      },
    );
  }

  function deleteSessionById(sessionId) {
    if (!sessionId) return;
    closeSelect(el('ai-chat-history-select'));
    const session = state.sessionList.find((item) => String(item.id) === String(sessionId));
    const title = String(session?.title || state.currentSession?.title || '该对话');
    confirmDestructiveAction(
      `确认删除对话“${title}”吗？删除后无法恢复。`,
      () => performDeleteSessionById(sessionId),
    );
  }

  async function startNewConversation(options = {}) {
    if (state.loading) return;
    if (!options.skipSave && currentMessages().length) {
      await persistCurrentSession();
    }
    state.pausedChat = null;
    state.modelSelectionFromHistory = false;
    selectDefaultAiModel();
    state.currentSession = {
      id: makeSessionId(),
      title: '新对话',
      titleGenerated: false,
      modelId: String(el('ai-chat-model')?.value || ''),
      automationCardId: '',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    state.messages = [];
    state.lastQuotaCost = null;
    state.childQuota = null;
    renderQuota(state.quota);
    setStatus('');
    updateSessionTitleUi();
    renderWelcome();
    if (typeof refreshManagedParent === 'function') void refreshManagedParent();
    resetAiChatScroll();
    await refreshHistoryList();
    syncSendState();
    el('ai-chat-input')?.focus();
  }

  function ensureSessionForSend() {
    if (state.currentSession?.id) return state.currentSession;
    state.currentSession = {
      id: makeSessionId(),
      title: '新对话',
      titleGenerated: false,
      modelId: String(el('ai-chat-model')?.value || ''),
      automationCardId: '',
      messages: state.messages,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    return state.currentSession;
  }

  async function maybeGenerateTitle(modelId) {
    const session = state.currentSession;
    if (!canGenerateSessionTitle(session, modelId)) return;
    const messages = findTitleMessages();
    if (!messages.user || !messages.assistant) return;
    const scope = historyLocalScope();
    state.generatingTitle = true;
    try {
      await ensureProvisionalSessionTitle(session, messages.user);
      if (historyLocalScope() !== scope) return;
      const result = await requestGeneratedSessionTitle(modelId, messages);
      if (historyLocalScope() === scope) await applyGeneratedSessionTitle(session.id, result);
    } catch (error) {
      console.warn('[AI 控制] 标题生成失败:', error?.message || error);
    } finally {
      state.generatingTitle = false;
    }
  }

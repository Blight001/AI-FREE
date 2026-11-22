  async function bootstrapHistory() {
    try {
      await refreshHistoryList();
    } catch (error) {
      console.warn('[AI 控制] 初始化历史失败:', error?.message || error);
    }
    // 启动与账号刷新只补齐历史列表，不恢复上次会话。异步恢复会在用户已经
    // 新建或开始输入后覆盖当前状态，表现为对话自动跳回旧会话。
    if (!state.currentSession) await startNewConversation({ skipSave: true });
  }

  function bindAiHeaderEvents() {
    el('ai-chat-redeem-gift')?.addEventListener('click', redeemGiftCode);
    el('ai-chat-gift-code')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        redeemGiftCode();
      }
    });
    window.addEventListener('ai-control-quota-updated', (event) => {
      state.lastQuotaCost = null;
      renderQuota(event?.detail || null);
      syncSendState();
    });
    el('ai-chat-model')?.addEventListener('change', () => {
      const modelId = String(el('ai-chat-model')?.value || '');
      if (modelId) void rememberModelChoice(modelId);
      state.lastQuotaCost = null;
      renderQuota(state.quota);
      syncSendState();
      if (state.currentSession) {
        state.currentSession.modelId = modelId;
        if (currentMessages().length) void persistCurrentSession();
      }
    });
  }

  function bindChatForm() {
    el('ai-chat-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      if (state.loading && !chatInputHasSendableContent()) stopAIOutput();
      else sendMessage();
    });
  }

  function handleCompositionEnd(chatInput, event) {
    const unexpectedlyCleared = !state.aiInputCompositionCancelled
      && !String(event.data || '')
      && chatInput.value === state.aiInputCompositionBase
      && state.aiInputCompositionDraft !== state.aiInputCompositionBase;
    if (unexpectedlyCleared) chatInput.value = state.aiInputCompositionDraft;
    state.aiInputComposing = false;
    state.aiInputCompositionBase = '';
    state.aiInputCompositionDraft = '';
    state.aiInputCompositionCancelled = false;
    delete document.documentElement.dataset.aiInputComposing;
    resizeInput();
    syncSendState();
    flushDeferredAiControlRefresh();
  }

  function bindChatInput() {
    const chatInput = el('ai-chat-input');
    // 用户点击文本框时由全局侧栏输入路由统一处理原生焦点，避免这里再发起
    // 第二套主页面 → 侧栏焦点切换。程序化聚焦仍通过 reclaimAiInputFocus。
    chatInput?.addEventListener('input', () => {
      if (state.aiInputComposing) {
        state.aiInputCompositionDraft = chatInput.value;
      }
      resizeInput();
      syncSendState();
      if (!chatInput.value) flushDeferredAiControlRefresh();
      renderMentionMenu();
    });
    chatInput?.addEventListener('compositionstart', () => {
      state.aiInputComposing = true;
      state.aiInputCompositionBase = chatInput.value;
      state.aiInputCompositionDraft = chatInput.value;
      state.aiInputCompositionCancelled = false;
      document.documentElement.dataset.aiInputComposing = 'true';
    });
    chatInput?.addEventListener('compositionend', (event) => handleCompositionEnd(chatInput, event));
    chatInput?.addEventListener('blur', () => {
      window.setTimeout(flushDeferredAiControlRefresh, 0);
    });
    chatInput?.addEventListener('keydown', (event) => {
      if (handleChatMentionKey(event)) return;
      if (state.aiInputComposing && event.key === 'Escape') {
        state.aiInputCompositionCancelled = true;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing
        && event.keyCode !== 229 && !state.aiInputComposing) {
        event.preventDefault();
        sendMessage();
      }
    });
    chatInput?.addEventListener('click', renderMentionMenu);
  }

  function bindAiAccountSessionRefresh() {
    window.aiFree?.account?.onSessionUpdated?.(() => {
      if (aiInputHasActiveDraft()) {
        state.accountSessionRefreshQueued = true;
        return;
      }
      loadModels();
      loadMcpTools();
      void bootstrapHistory();
    });
  }

  function bindCustomModelRefresh() {
    window.aiFree?.ai?.onCustomModelsUpdated?.(() => void loadModels());
  }

  function startAiControlPolling() {
    loadModels();
    loadMcpTools();
    void bootstrapHistory();
    // 刷新 @ 菜单的数据源；对话的浏览器连接由主进程在每轮开始时读取。
    window.setInterval(loadMcpTools, 750);
  }

  // 正常关闭/刷新时再做一次同步本地检查点；即使 IPC 来不及完成，消息也不会丢失。
  window.addEventListener('pagehide', () => {
    if (currentMessages().length) checkpointCurrentSession();
  });

  document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('ai-control-panel')) return;
    window.MessageModal?.initServerMessageListener?.();
    if (typeof initSidebarAnimationListener === 'function') initSidebarAnimationListener();
    if (typeof initSidebarInputRouting === 'function') initSidebarInputRouting();
    initCustomSelects();
    bindAiHeaderEvents();
    bindAiChatScroll();
    bindChatUploadConfirmation();
    bindChatForm();
    bindChatInput();
    if (typeof bindChatWorkspace === 'function') bindChatWorkspace();
    bindAiAccountSessionRefresh();
    bindCustomModelRefresh();
    startAiControlPolling();
  });

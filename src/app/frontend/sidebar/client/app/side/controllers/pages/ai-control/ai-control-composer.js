  function resizeInput() {
    const input = el('ai-chat-input');
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 130)}px`;
  }

  function focusElement(input) {
    if (!input) return;
    try {
      input.focus({ preventScroll: true });
    } catch (_) {
      try { input.focus(); } catch (__) {}
    }
  }

  /**
   * 侧栏是 WebContentsView：OS/Chromium 子窗口可能抢走键盘焦点，
   * 而 DOM 仍显示 输入框处于 focus 状态，表现为“已聚焦但无法输入”。
   * 这里通过主进程把键盘焦点拉回侧栏 webContents，再回焦输入框。
   */
  function reclaimAiInputFocus(input) {
    if (!input || state._aiInputReclaiming) return;
    if (!window.aiFree?.ui?.focusSidebarInput) {
      focusElement(input);
      return;
    }

    const now = Date.now();
    // 短防抖：pointerdown/click 连续触发时只回收一次
    if (state._aiInputReclaimAt && now - state._aiInputReclaimAt < 120) return;
    state._aiInputReclaimAt = now;

    const token = Symbol('ai-input-focus');
    state._aiInputFocusToken = token;
    state._aiInputReclaiming = true;

    const refocus = () => {
      if (state._aiInputFocusToken !== token) return;
      if (aiInputHasActiveDraft()) return;
      // 若用户已点到别处，不要强行抢回
      if (document.activeElement && document.activeElement !== input) {
        const active = document.activeElement;
        if (active !== document.body && active !== document.documentElement) return;
      }
      focusElement(input);
    };

    // 等本轮 click 的原生聚焦完成后再向主进程要键盘焦点，避免互相打架
    window.setTimeout(() => {
      if (state._aiInputFocusToken !== token) {
        state._aiInputReclaiming = false;
        return;
      }
      void window.aiFree.ui.focusSidebarInput({ interaction: 'text-input' }).then(() => {
        refocus();
        state._aiInputReclaiming = false;
      }).catch((error) => {
        console.warn('[AI 控制] 恢复输入框焦点失败:', error?.message || error);
        refocus();
        state._aiInputReclaiming = false;
      });
    }, 0);
  }

  let checkingChatLogin = false;

  async function ensureAuthenticatedForChat() {
    try {
      const session = await window.aiFree?.account?.getSession?.();
      state.accountAuthenticated = session?.authenticated === true;
      syncSendState();
      if (state.accountAuthenticated) return true;
    } catch (_) {}
    state.accountAuthenticated = false;
    syncSendState();
    window.aiFree?.ui?.requestAccountCenter?.();
    return false;
  }

  async function insertMessageDuringRun(content, input) {
    if (!state.activeRequestId || state.stopping) return;
    const messages = currentMessages();
    messages.push({ role: 'user', content });
    appendMessage('user', content, { messageIndex: messages.length - 1 });
    if (input) {
      writeChatDraft(input);
      resizeInput();
      flushDeferredAiControlRefresh();
    }
    syncSendState();
    // 用户输入先同步写入 localStorage，再通知正在运行的服务端会话。
    void persistCurrentSession();
    try {
      const result = await window.aiFree.ai.chatInsert({
        requestId: state.activeRequestId,
        content,
      });
      if (!result?.ok) throw new Error(result?.message || '当前 AI 回复已经结束');
    } catch (error) {
      const message = error?.message || String(error);
      messages.push({ role: 'assistant', content: `请求失败：${message}` });
      appendMessage('assistant', `请求失败：${message}`);
      await persistCurrentSession();
      setStatus(message, 'warning');
      syncSendState();
    }
  }

  let submittedChatRequestId = '';

  async function requestChatStop(requestId) {
    try {
      const result = await window.aiFree.ai.chatStop({ requestId });
      if (!result?.ok) throw new Error(result?.message || '停止 AI 回复失败');
    } catch (error) {
      if (state.activeRequestId !== requestId) return;
      state.stopping = false;
      syncSendState();
      setStatus(error?.message || String(error));
    }
  }

  async function stopAIOutput() {
    if (!state.loading || !state.activeRequestId || state.stopping) return;
    state.stopping = true;
    syncSendState();
    if (submittedChatRequestId === state.activeRequestId) await requestChatStop(submittedChatRequestId);
  }

  async function refreshQuotaBeforeSend(useCustomApi) {
    if (useCustomApi) return;
    try {
      const result = await window.aiFree?.ai?.getModels?.();
      if (result?.quota) renderQuota(result.quota);
    } catch (_) {}
  }

  function prepareChatSend(input, select, content, draftAttachments) {
    const useCustomApi = selectedModelIsCustom();
    if (!select?.value) return null;
    ensureSessionForSend();
    state.pausedChat = null;
    const messages = currentMessages();
    const attachmentContext = typeof takeChatAttachmentContext === 'function'
      ? takeChatAttachmentContext(content, draftAttachments)
      : { attachmentPaths: [], inlineAttachments: [], mentions: [] };
    const inlineAttachments = attachmentContext.inlineAttachments || [];
    const wasFirstExchange = !messages.some((message) => message.role === 'assistant' && String(message.content || '').trim());
    const userMessage = { role: 'user', content };
    if (attachmentContext.attachmentPaths.length > 0) {
      userMessage.attachmentPaths = attachmentContext.attachmentPaths;
    }
    if (inlineAttachments.length > 0) {
      userMessage.inlineAttachments = inlineAttachments;
    }
    messages.push(userMessage);
    appendMessage('user', content, {
      messageIndex: messages.length - 1,
      attachmentPaths: attachmentContext.attachmentPaths,
      inlineAttachments,
    });
    updateSessionTitleUi();
    writeChatDraft(input);
    resizeInput();
    flushDeferredAiControlRefresh();
    state.loading = true;
    state.stopping = false;
    setStatus('');
    const run = { content, input, messages, modelId: select.value, useCustomApi, wasFirstExchange, ...attachmentContext };
    updateCurrentSessionAfterChat(run);
    syncSendState();
    // 本地写入在函数首次 await 前同步完成；主进程文件保存排队在后台，不阻塞请求发送。
    void persistCurrentSession();
    return run;
  }

  function handleInsertedStreamMessage(run) {
    run.insertedDuringRun = true;
    run.streamView?.finalize();
    run.streamView = createAssistantView({ pending: true });
  }


  function handleChatStreamEvent(run, event) {
    if (!event || event.requestId !== run.requestId) return;
    applyChatPresentationEvent(run, event);
  }

  function subscribeChatStream(run) {
    run.streamView ||= createAssistantView({ pending: true });
    return window.aiFree?.ai?.onChatEvent?.((event) => handleChatStreamEvent(run, event));
  }

  function buildChatRequest(run) {
    if (run.resumeRequestId) {
      return { stream: true, requestId: run.requestId, resumeRequestId: run.resumeRequestId, quota: state.quota };
    }
    return {
      parentSessionId: state.currentSession?.id || '',
      modelId: run.modelId,
      messages: run.messages,
      quota: run.useCustomApi ? null : state.quota,
      localInteraction: true,
      automationCardId: '',
      stream: true,
      requestId: run.requestId,
      attachmentPaths: run.attachmentPaths,
      artifactReferences: run.artifactReferences || [],
      mentions: run.mentions,
    };
  }

  function handleChatBusinessFailure(result) {
    const message = String(result?.message || result?.error || '对话请求失败');
    if (/请先.*登录|未登录/.test(message)) {
      window.aiFree?.ui?.requestAccountCenter?.();
    }
    if (isQuotaFailure(message)) {
      if (result?.quota) renderQuota(result.quota);
      showChatBusinessError(message);
    }
  }

  function applyReturnedMessages(run, result) {
    if (Array.isArray(result.messages) && result.messages.length) {
      state.messages = result.messages;
      return;
    }
    if (!result.stopped) run.messages.push({ role: 'assistant', content: String(result.message?.content || '').trim() });
  }

  function applyFinalAssistantMetadata({ message, stopped }, durationMs) {
    const { content, reasoning, tool_events: toolEvents, trace_events: traceEvents, artifacts } = message || {};
    if (stopped && !hasAssistantMessageContent(content, { reasoning, toolEvents, traceEvents, artifacts })) {
      state.messages.push({ role: 'assistant', content: '', turn_duration_ms: durationMs });
      return;
    }
    const finalAssistant = [...state.messages].reverse().find((item) => item?.role === 'assistant');
    if (!finalAssistant) return;
    finalAssistant.turn_duration_ms = durationMs;
    finalAssistant.reasoning = String(reasoning || '');
    finalAssistant.tool_events = Array.isArray(toolEvents) ? toolEvents : [];
    finalAssistant.trace_events = Array.isArray(traceEvents) ? traceEvents : [];
    finalAssistant.artifacts = Array.isArray(artifacts) ? artifacts : [];
  }

  function updateCurrentSessionAfterChat(run) {
    if (!state.currentSession) return;
    state.currentSession.modelId = run.modelId;
    state.currentSession.automationCardId = '';
    if (!state.currentSession.title || state.currentSession.title === '新对话') {
      state.currentSession.title = provisionalTitle(run.content);
    }
  }

  function applyStoppedChatResult(run, result, replyText, durationMs) {
    if (replyText) run.streamView?.setContent(replyText, { foldTools: false });
    renderConversationDownloads(state.messages);
    run.streamView?.finalize({ durationMs, paused: true });
    syncPausedChatRows(run.streamView?.row);
    if (!result.resumable) return;
    state.pausedChat = {
      requestId: run.requestId, modelId: run.modelId, useCustomApi: run.useCustomApi,
      content: run.content, wasFirstExchange: run.wasFirstExchange,
      streamView: run.streamView,
      insertedDuringRun: run.insertedDuringRun, durationMs,
    };
  }

  function measureChatRun(run) {
    return (run.durationMs || 0) + Math.round(performance.now() - run.startedAt);
  }

  async function applyChatResult(run, result) {
    const durationMs = measureChatRun(run);
    applyReturnedMessages(run, result);
    const replyText = String(result.message?.content || '').trim();
    applyFinalAssistantMetadata(result, durationMs);
    updateCurrentSessionAfterChat(run);
    state.pausedChat = null;
    if (result.stopped) {
      applyStoppedChatResult(run, result, replyText, durationMs);
      await persistCurrentSession();
      return;
    }
    run.streamView?.setContent(replyText || '模型未返回内容');
    renderConversationDownloads(state.messages);
    run.streamView?.finalize({ durationMs });
    if (run.insertedDuringRun) {
      renderConversation();
      renderChatScreenshot(el('ai-chat-message-list')?.querySelector('.assistant:last-child .ai-chat-assistant-stack'), run.screenshot);
    }
    await persistCurrentSession();
    if (run.wasFirstExchange) void maybeGenerateTitle(run.modelId);
  }

  async function handleChatSendError(run, error) {
    const message = error?.message || String(error);
    const failureContent = `请求失败：${message}`;
    const durationMs = measureChatRun(run);
    run.messages.push({ role: 'assistant', content: failureContent, turn_duration_ms: durationMs, artifacts: run.downloads });
    run.streamView?.setContent(failureContent);
    run.streamView?.finalize({ durationMs });
    updateCurrentSessionAfterChat(run);
    await persistCurrentSession();
    setStatus(message);
  }

  function applyChatRequestQuota(run, result) {
    const amount = result?.quotaUsed;
    if (amount > 0 && state.currentSession) {
      state.currentSession.quotaUsed = window.AiFreeQuotaDisplay.addChatQuotaUsed(state.currentSession.quotaUsed, amount);
      // Resumed failures do not append a new error turn, so save their charges here.
      if (run.resumeRequestId && !result.ok) void persistCurrentSession();
    }
    if (!result?.ok && !(amount > 0)) return;
    state.lastQuotaCost = amount > 0 ? amount : null;
    renderQuota(run.useCustomApi ? state.quota : (result.quota || state.quota));
  }

  async function requestChatResult(run) {
    await refreshQuotaBeforeSend(run.useCustomApi);
    if (!run.useCustomApi && isQuotaExhausted()) {
      throw new Error('AI 对话额度已用尽，请联系管理员');
    }
    const pending = window.aiFree.ai.chat(buildChatRequest(run));
    submittedChatRequestId = run.requestId;
    if (state.stopping) void requestChatStop(run.requestId);
    const result = await pending;
    applyChatRequestQuota(run, result);
    if (result?.ok) return result;
    handleChatBusinessFailure(result);
    if (result?.errorCode === 'AI_CONTINUATION_UNAVAILABLE') state.pausedChat = null;
    throw new Error(String(result?.message || result?.error || '对话请求失败'));
  }

  function finishChatSend(run) {
    run.unsubscribeStream?.();
    state.loading = false;
    state.stopping = false;
    state.activeRequestId = '';
    submittedChatRequestId = '';
    syncSendState();
    updateSessionTitleUi();
    run.input?.focus({ preventScroll: true });
  }

  async function performChatRun(run) {
    run.startedAt = performance.now();
    run.requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    state.activeRequestId = run.requestId;
    run.unsubscribeStream = subscribeChatStream(run);
    try {
      await applyChatResult(run, await requestChatResult(run));
    } catch (error) {
      if (run.resumeRequestId) {
        if (run.responseStarted) {
          state.pausedChat = null;
          run.streamView?.setContent(`请求失败：${error?.message || String(error)}`);
        }
        run.streamView?.finalize({ durationMs: run.responseStarted ? measureChatRun(run) : run.durationMs, paused: !run.responseStarted });
        setStatus(error?.message || String(error));
      } else await handleChatSendError(run, error);
    } finally {
      finishChatSend(run);
    }
  }

  async function resumeAIOutput() {
    const paused = state.pausedChat;
    const input = el('ai-chat-input');
    if (!paused || state.loading || checkingChatLogin || chatInputHasSendableContent(input) || readChatDraft(input).pending) return;
    const run = { ...paused, input, messages: currentMessages(), resumeRequestId: paused.requestId };
    state.loading = true;
    state.stopping = false;
    setStatus('');
    syncSendState();
    await performChatRun(run);
  }

  async function sendMessage() {
    const input = el('ai-chat-input');
    const select = el('ai-chat-model');
    const draft = readChatDraft(input);
    if (draft.pending) return;
    const typedContent = draft.content.trim();
    const content = typedContent || (hasSelectedChatAttachments() ? '请查看并处理所附文件。' : '');
    if (!content) return;
    if (state.loading) {
      if (draft.inlineAttachments.length) {
        setStatus('图片附件可在当前回复结束后发送', 'warning');
        return;
      }
      await insertMessageDuringRun(content, input);
      return;
    }

    if (checkingChatLogin) return;
    if (!selectedModelIsCustom()) {
      checkingChatLogin = true;
      try {
        if (!await ensureAuthenticatedForChat()) return;
      } finally {
        checkingChatLogin = false;
      }
      const currentDraft = readChatDraft(input);
      if (currentDraft.pending || currentDraft.content.trim() !== typedContent
        || JSON.stringify(currentDraft.inlineAttachments) !== JSON.stringify(draft.inlineAttachments)) return;
    }
    const run = prepareChatSend(input, select, content, draft.inlineAttachments);
    if (!run) return;
    await performChatRun(run);
  }

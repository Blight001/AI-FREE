  async function copyTextToClipboard(text) {
    const value = String(text || '');
    if (!value) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (_) {}
    try {
      const area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  /** 从 userIndex 起，到下一条 user（不含）或数组末尾 */
  function findTurnEndExclusive(messages, userIndex) {
    let end = userIndex + 1;
    while (end < messages.length && messages[end]?.role !== 'user') end += 1;
    return end;
  }

  function resolveUserMessageIndex(row) {
    const fromAttr = Number(row?.dataset?.messageIndex);
    if (Number.isInteger(fromAttr) && fromAttr >= 0) return fromAttr;
    return -1;
  }

  async function copyUserBubble(row) {
    const text = String(row?.dataset?.content || row?.querySelector?.('.ai-chat-bubble')?.textContent || '');
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setStatus('已复制到剪贴板', 'success');
    } else {
      setStatus('复制失败，请手动选择文本', 'warning');
    }
  }

  async function performRecallUserBubble(row) {
    if (state.loading) {
      setStatus('请等待当前回复完成后再撤回', 'warning');
      return;
    }
    const userIndex = resolveUserMessageIndex(row);
    const messages = currentMessages();
    if (userIndex < 0 || userIndex >= messages.length || messages[userIndex]?.role !== 'user') {
      setStatus('无法定位该消息', 'warning');
      return;
    }
    const { content, inlineAttachments } = messages[userIndex];
    // 撤回：删除该气泡及之后的全部内容
    messages.splice(userIndex);
    state.pausedChat = null;
    syncSendState();
    const input = el('ai-chat-input');
    if (input) {
      writeChatDraft(input, String(content || ''), inlineAttachments);
      resizeInput();
      syncSendState();
      reclaimAiInputFocus(input);
    }
    if (!messages.length) {
      if (state.currentSession) {
        state.currentSession.title = '新对话';
        state.currentSession.titleGenerated = false;
      }
      renderWelcome();
    } else {
      renderConversation();
    }
    updateSessionTitleUi();
    await persistCurrentSession();
  }

  function recallUserBubble(row) {
    if (state.loading) {
      setStatus('请等待当前回复完成后再撤回', 'warning');
      return;
    }
    const userIndex = resolveUserMessageIndex(row);
    const messages = currentMessages();
    if (userIndex < 0 || userIndex >= messages.length || messages[userIndex]?.role !== 'user') {
      setStatus('无法定位该消息', 'warning');
      return;
    }
    confirmDestructiveAction(
      '确认撤回这条消息吗？该消息及其之后的对话内容将被移除，消息内容会放回输入框。',
      () => performRecallUserBubble(row),
    );
  }

  async function performDeleteUserTurn(row) {
    if (state.loading) {
      setStatus('请等待当前回复完成后再删除', 'warning');
      return;
    }
    const userIndex = resolveUserMessageIndex(row);
    const messages = currentMessages();
    if (userIndex < 0 || userIndex >= messages.length || messages[userIndex]?.role !== 'user') {
      setStatus('无法定位该消息', 'warning');
      return;
    }
    // 删除：仅移除本轮用户消息及其对应 AI 回复（含中间 tool 消息），不影响后续轮次
    const end = findTurnEndExclusive(messages, userIndex);
    messages.splice(userIndex, end - userIndex);
    state.pausedChat = null;
    syncSendState();
    if (!messages.length) {
      if (state.currentSession) {
        state.currentSession.title = '新对话';
        state.currentSession.titleGenerated = false;
      }
      renderWelcome();
    } else {
      renderConversation();
    }
    updateSessionTitleUi();
    await persistCurrentSession();
  }

  function deleteUserTurn(row) {
    if (state.loading) {
      setStatus('请等待当前回复完成后再删除', 'warning');
      return;
    }
    const userIndex = resolveUserMessageIndex(row);
    const messages = currentMessages();
    if (userIndex < 0 || userIndex >= messages.length || messages[userIndex]?.role !== 'user') {
      setStatus('无法定位该消息', 'warning');
      return;
    }
    confirmDestructiveAction(
      '确认删除这轮对话吗？该条消息及其对应的 AI 回复将被删除，删除后无法恢复。',
      () => performDeleteUserTurn(row),
    );
  }

  function attachUserBubbleActions(row, content, messageIndex, editable) {
    if (!row) return;
    row.dataset.messageIndex = String(messageIndex);
    row.dataset.content = String(content || '');

    const wrap = document.createElement('div');
    wrap.className = 'ai-chat-user-wrap';

    const actions = document.createElement('div');
    actions.className = 'ai-chat-user-actions';
    actions.setAttribute('aria-label', '消息操作');

    const makeBtn = (action, title, symbol) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ai-chat-msg-action';
      btn.dataset.action = action;
      btn.title = title;
      btn.setAttribute('aria-label', title);
      btn.innerHTML = `<span class="ai-chat-msg-action-icon" aria-hidden="true">${symbol}</span>`;
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (action === 'copy') void copyUserBubble(row);
        else if (action === 'recall') void recallUserBubble(row);
        else if (action === 'delete') void deleteUserTurn(row);
      });
      return btn;
    };

    // 从左到右：复制、撤回、删除
    actions.append(makeBtn('copy', '复制', '❐'));
    if (editable) actions.append(makeBtn('recall', '撤回', '↩'), makeBtn('delete', '删除', '✕'));

    const bubble = row.querySelector('.ai-chat-bubble');
    if (bubble) {
      wrap.append(actions, bubble);
      row.appendChild(wrap);
    }
  }

  function hasAssistantMessageContent(content, options) {
    if (String(content || '').trim()) return true;
    if (options.pending || String(options.reasoning || '').trim()) return true;
    if (Number.isSafeInteger(options.durationMs) && options.durationMs >= 0) return true;
    return (Array.isArray(options.toolEvents) && options.toolEvents.length > 0)
      || (Array.isArray(options.traceEvents) && options.traceEvents.length > 0)
      || (Array.isArray(options.artifacts) && options.artifacts.length > 0);
  }

  function appendUserMessageFiles(bubble, attachmentPaths) {
    if (!Array.isArray(attachmentPaths) || !attachmentPaths.length) return;
    const files = document.createElement('div');
    files.className = 'ai-chat-message-files';
    attachmentPaths.forEach((filePath) => {
      const item = document.createElement('span');
      item.textContent = `📎 ${filePath}`;
      item.title = filePath;
      files.appendChild(item);
    });
    bubble.appendChild(files);
  }

  function appendMessage(role, content, options = {}, container = el('ai-chat-message-list')) {
    if (!container) return null;
    if (role === 'tool' || role === 'system') return null;
    if (role === 'assistant' && !hasAssistantMessageContent(content, options)) return null;
    if (role === 'assistant') return createAssistantView({ ...options, content }, container);
    const welcome = container.querySelector('.ai-chat-welcome');
    if (welcome) welcome.remove();
    const row = document.createElement('article');
    row.className = `ai-chat-message ${role}${options.pending ? ' pending' : ''}`;
    row.dataset.messageKind = role === 'user' ? 'user-bubble' : role;
    const bubble = document.createElement('div');
    bubble.className = 'ai-chat-bubble';
    bubble.textContent = content;
    if (role === 'user') appendUserMessageFiles(bubble, options.attachmentPaths);
    row.appendChild(bubble);
    if (role === 'user') {
      const messageIndex = Number.isInteger(options.messageIndex)
        ? options.messageIndex
        : currentMessages().length - 1;
      attachUserBubbleActions(row, content, messageIndex, options.editable !== false);
    }
    container.appendChild(row);
    return row;
  }

  function isRenderableConversationMessage(message) {
    if (message?.role === 'user') return true;
    if (message?.role !== 'assistant') return false;
    // 带 tool_calls 的 assistant 是模型协议消息；其内容已经由最终回复的
    // trace_events 重建为活动/阶段答案，不能再渲染成独立 AI 气泡。
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) return false;
    return hasAssistantMessageContent(message.content, {
      reasoning: message.reasoning,
      toolEvents: message.tool_events,
      traceEvents: message.trace_events,
      durationMs: message.turn_duration_ms,
      artifacts: message.artifacts,
    });
  }

  function createWelcomeHero() {
    const hero = document.createElement('div');
    hero.className = 'ai-chat-welcome-hero';
    const logoFrame = document.createElement('span');
    logoFrame.className = 'ai-chat-welcome-logo';
    const logo = document.createElement('img');
    logo.className = 'ai-chat-welcome-icon';
    logo.src = window.aiFreeLogoAssets.url;
    logo.alt = '';
    logo.setAttribute('aria-hidden', 'true');
    logo.setAttribute('data-app-logo', '');
    logoFrame.appendChild(logo);
    const title = document.createElement('strong');
    title.textContent = '今天想一起完成什么？';
    const summary = document.createElement('p');
    summary.textContent = '直接描述你的目标即可。';
    hero.append(logoFrame, title, summary);
    return hero;
  }

  function renderWelcome() {
    if (typeof syncWorkspaceDraftSession === 'function') syncWorkspaceDraftSession();
    renderConversationDownloads([]);
    const container = el('ai-chat-message-list');
    if (!container) return;
    container.innerHTML = '';
    const welcome = document.createElement('div');
    welcome.className = 'ai-chat-welcome';
    welcome.appendChild(createWelcomeHero());
    container.appendChild(welcome);
    updateSessionTitleUi();
  }

  function syncPausedChatRows(assistantRow) {
    const container = el('ai-chat-message-list');
    if (!container) return;
    const messages = currentMessages();
    const userRows = [...container.querySelectorAll(':scope > [data-message-kind="user-bubble"]')];
    let nextIndex = 0;
    userRows.forEach((row) => {
      const currentIndex = Number(row.dataset.messageIndex);
      if (Number.isInteger(currentIndex) && messages[currentIndex]?.role === 'user') {
        nextIndex = currentIndex + 1;
        return;
      }
      while (nextIndex < messages.length && messages[nextIndex]?.role !== 'user') nextIndex += 1;
      if (nextIndex < messages.length) row.dataset.messageIndex = String(nextIndex++);
    });
    const lastUser = userRows.at(-1);
    if (lastUser && assistantRow && (assistantRow.compareDocumentPosition(lastUser) & Node.DOCUMENT_POSITION_FOLLOWING)) {
      lastUser.after(assistantRow);
    }
  }

  const AI_HISTORY_INITIAL_WINDOW = 56;
  const AI_HISTORY_PAGE_SIZE = 40;

  function addLoadOlderMessagesButton(container) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ai-chat-history-load-older';
    button.textContent = '加载更早的消息';
    button.setAttribute('aria-label', '加载更早的对话消息');
    button.addEventListener('click', loadOlderConversationMessages);
    container.appendChild(button);
  }

  function renderMessageRange(messages, start, end, container) {
    for (let index = start; index < end; index += 1) {
      const message = messages[index];
      if (isRenderableConversationMessage(message)) {
        renderChatMessage(message, { messageIndex: index }, container);
      }
    }
  }

  function loadOlderConversationMessages() {
    const messages = currentMessages();
    const end = Number(state.historyMessageWindowStart) || 0;
    if (!end) return;
    const start = aiControlMessageWindowStart(messages, end, AI_HISTORY_PAGE_SIZE);
    if (start >= end) return;
    const viewport = el('ai-chat-messages');
    const container = el('ai-chat-message-list');
    if (!container) return;
    const oldHeight = viewport?.scrollHeight || 0;
    const oldTop = viewport?.scrollTop || 0;
    container.querySelector('.ai-chat-history-load-older')?.remove();
    const fragment = document.createDocumentFragment();
    if (start > 0) addLoadOlderMessagesButton(fragment);
    renderMessageRange(messages, start, end, fragment);
    container.insertBefore(fragment, container.firstChild);
    state.historyMessageWindowStart = start;
    if (viewport) requestAnimationFrame(() => {
      viewport.scrollTop = oldTop + viewport.scrollHeight - oldHeight;
    });
  }

  function renderConversation() {
    if (typeof syncWorkspaceDraftSession === 'function') syncWorkspaceDraftSession();
    const container = el('ai-chat-message-list');
    if (!container) return;
    const messages = currentMessages();
    const viewport = el('ai-chat-messages');
    const sessionId = String(state.currentSession?.id || '');
    const changedSession = state.historyMessageWindowSessionId !== sessionId;
    const atBottom = !viewport || viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 4;
    let start = Number(state.historyMessageWindowStart);
    if (changedSession || atBottom || !Number.isInteger(start) || start >= messages.length) {
      start = aiControlMessageWindowStart(messages, messages.length, AI_HISTORY_INITIAL_WINDOW);
    }
    state.historyMessageWindowSessionId = sessionId;
    state.historyMessageWindowStart = start;
    container.innerHTML = '';
    renderConversationDownloads(messages);
    if (start > 0) addLoadOlderMessagesButton(container);
    if (!messages.length || !messages.some(isRenderableConversationMessage)) {
      renderWelcome();
      return;
    }
    renderMessageRange(messages, start, messages.length, container);
    updateSessionTitleUi();
  }

  function chatInputHasSendableContent(input = el('ai-chat-input')) {
    const hasAttachments = typeof hasSelectedChatAttachments === 'function'
      && hasSelectedChatAttachments();
    const draft = readChatDraft(input);
    if (draft.pending || (state.loading && draft.inlineAttachments.length)) return false;
    return Boolean(draft.content.trim()) || (!state.loading && hasAttachments);
  }

  function syncSendState() {
    const send = el('ai-chat-send');
    const input = el('ai-chat-input');
    const model = el('ai-chat-model');
    const modelUnavailable = !model?.value;
    const hasContent = chatInputHasSendableContent(input);
    const mode = resolveChatButtonMode(hasContent);
    const useCustomApi = mode.icon === 'play' ? state.pausedChat.useCustomApi : selectedModelIsCustom();
    const quotaExhausted = !useCustomApi && state.accountAuthenticated && isQuotaExhausted();
    if (send) {
      send.disabled = state.loading
        ? state.stopping
        : quotaExhausted || (mode.icon === 'play'
          ? readChatDraft(input).pending
          : modelUnavailable || !hasContent);
      renderChatSendButton(send, mode);
    }
  }

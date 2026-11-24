  const managedStatusNames = {
    idle: '待发送', running: '运行中', stopping: '正在停止', paused: '已暂停',
    completed: '已完成', failed: '失败', needs_review: '需核验',
  };
  const managedChatUi = {
    view: '', modelId: '', revision: 0, messages: null, resetScroll: null, rows: new Map(),
    parentId: null, parentRevision: 0, parentPosition: null, parentDirty: false, timer: null,
  };

  async function managedChatCall(action, args = {}) {
    const result = await window.aiFree.ai.managedChat({ action, ...args });
    if (!result?.ok) throw new Error(result?.error?.message || '无法读取子对话');
    return result.data;
  }

  function managedChatError(error) {
    if (managedChatUi.view) el('ai-managed-status').textContent = error.message;
  }

  function drawManagedCards(container, sessions) {
    const active = document.activeElement?.dataset?.managedSessionId;
    const buttons = sessions.map((session) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ai-managed-card';
      button.dataset.managedSessionId = session.sessionId;
      button.textContent = `↗ ${session.title} · ${managedStatusNames[session.status] || session.status}`;
      button.addEventListener('click', () => void openManagedView(session.sessionId).catch(managedChatError));
      return button;
    });
    container.replaceChildren(...buttons);
    container.hidden = !buttons.length;
    if (active) buttons.find((button) => button.dataset.managedSessionId === active)?.focus();
  }

  async function refreshManagedParent() {
    const target = el('ai-managed-parent-cards');
    if (!target || !window.aiFree?.ai?.managedChat) return;
    const parentId = state.currentSession?.id || null;
    const revision = ++managedChatUi.parentRevision;
    if (managedChatUi.parentId !== parentId) {
      managedChatUi.parentId = parentId;
      drawManagedCards(target, []);
    }
    if (!parentId) return;
    let sessions = [];
    try {
      ({ sessions } = await managedChatCall('list', { parent_id: parentId }));
    } catch {
      // Match the existing empty card state when the child list is unavailable.
    }
    if (state.currentSession?.id !== parentId || revision !== managedChatUi.parentRevision) return;
    const add = window.AiFreeQuotaDisplay.addChatQuotaUsed;
    state.childQuota = { parentId, used: sessions.reduce((total, session) => add(total, session.quotaUsed), 0) };
    renderConversationQuotaUsed();
    drawManagedCards(target, sessions);
  }

  function markManagedPane(open) {
    const pane = el('ai-managed-chat');
    pane.hidden = !open;
    pane.parentElement.classList.toggle('is-managed-view', open);
    for (const node of pane.parentElement.children) {
      if (node !== pane && node.id !== 'ai-chat-workspace-preview') node.inert = open;
    }
  }

  function advanceManagedStream(entry, events) {
    for (const event of events) {
      if (event.seq < entry.sequence) continue;
      if (event.delta !== undefined) {
        const delta = event.delta.slice(event.seq === entry.sequence ? entry.offset : 0);
        if (delta) applyChatPresentationEvent(entry, { ...event, delta });
        entry.offset = event.delta.length;
      } else if (event.seq > entry.sequence) {
        applyChatPresentationEvent(entry, event);
      }
      entry.sequence = event.seq;
    }
  }

  function managedMessageEntry(message, oldEntry, attempt, paused) {
    if (oldEntry && oldEntry.revision === message.revision && oldEntry.attempt === attempt) return oldEntry;
    const container = managedChatUi.messages;
    const rendered = renderChatMessage(message, { editable: false, canReference: false, paused }, container);
    const row = rendered?.row || rendered;
    if (!row) return null;
    if (oldEntry) {
      if (paused) preservePausedDisclosures(row, oldEntry.row);
      container.insertBefore(row, oldEntry.row);
      oldEntry.row.remove();
    }
    return { row, streamView: rendered, revision: message.revision, attempt, sequence: 0, offset: 0, canReference: false };
  }

  function renderManagedMessages(data) {
    const { messages, rows } = managedChatUi;
    const visible = new Set(data.messages.map(({ id }) => id));
    for (const [id, entry] of rows) {
      if (visible.has(id)) continue;
      entry.row.remove();
      rows.delete(id);
    }
    let cursor = messages.firstChild;
    for (const message of data.messages) {
      const paused = data.status === 'paused' && message.id === `${data.runId}:assistant`;
      const attempt = message.pending ? data.attempt : undefined;
      const entry = managedMessageEntry(message, rows.get(message.id), attempt, paused);
      if (!entry) continue;
      rows.set(message.id, entry);
      if (entry.row !== cursor && cursor?.parentNode === messages) messages.insertBefore(entry.row, cursor);
      cursor = entry.row.nextSibling;
      if (message.pending) advanceManagedStream(entry, data.events);
    }
    const lastAssistant = rows.get(`${data.runId}:assistant`);
    renderChatScreenshot(lastAssistant?.streamView?.stack, data.screenshot);
    const live = data.events?.findLast((event) => event.type === 'artifacts')?.artifacts;
    renderChatDownloads(el('ai-managed-downloads'), data.messages, live, false);
  }

  function renderManagedModel() {
    if (!managedChatUi.view) return;
    const { modelId } = managedChatUi;
    const options = el('ai-chat-model')?.options || [];
    const name = modelId && (Array.from(options).find((option) => option.value === modelId)?.textContent || modelId);
    el('ai-managed-model').textContent = name ? `模型：${name}` : '';
  }

  function renderManagedSession(data) {
    managedChatUi.modelId = data.modelId;
    el('ai-managed-title').textContent = data.title;
    renderQuotaUsed('ai-managed-quota-used', data.quotaUsed);
    el('ai-managed-status').textContent = managedStatusNames[data.status] || data.status;
    renderManagedModel();
    renderManagedMessages(data);
  }

  async function refreshManagedView() {
    const view = managedChatUi.view;
    const revision = ++managedChatUi.revision;
    if (!view) return;
    const data = await managedChatCall('status', { session_id: view });
    if (managedChatUi.revision === revision) renderManagedSession(data);
  }

  async function openManagedView(view) {
    managedChatUi.parentPosition = { id: state.currentSession?.id, top: el('ai-chat-messages').scrollTop };
    managedChatUi.view = view;
    managedChatUi.modelId = '';
    markManagedPane(true);
    el('ai-managed-title').textContent = '子对话';
    el('ai-managed-status').textContent = '';
    renderQuotaUsed('ai-managed-quota-used', 0);
    renderManagedModel();
    el('ai-managed-back').focus();
    managedChatUi.messages.replaceChildren();
    renderChatDownloads(el('ai-managed-downloads'), []);
    managedChatUi.rows.clear();
    await refreshManagedView();
    if (managedChatUi.view === view) managedChatUi.resetScroll();
  }

  function closeManagedView() {
    const sessionId = managedChatUi.view;
    managedChatUi.revision++;
    managedChatUi.view = '';
    managedChatUi.modelId = '';
    closeWorkspacePreview();
    markManagedPane(false);
    managedChatUi.messages.replaceChildren();
    managedChatUi.rows.clear();
    const position = managedChatUi.parentPosition;
    if (position && position.id === state.currentSession?.id) el('ai-chat-messages').scrollTop = position.top;
    const cards = el('ai-managed-parent-cards');
    const card = cards.querySelector(`[data-managed-session-id="${CSS.escape(sessionId)}"]`);
    (card || el('ai-chat-input')).focus({ preventScroll: true });
    managedChatUi.parentPosition = null;
  }

  function scheduleManagedRefresh(event) {
    if (event.parentId && event.parentId === state.currentSession?.id) managedChatUi.parentDirty = true;
    if (!managedChatUi.parentDirty && managedChatUi.view !== event.sessionId) return;
    if (managedChatUi.timer) return;
    managedChatUi.timer = window.setTimeout(() => {
      managedChatUi.timer = null;
      if (managedChatUi.parentDirty) void refreshManagedParent();
      managedChatUi.parentDirty = false;
      void refreshManagedView().catch(managedChatError);
    }, 90);
  }

  function bindManagedChat() {
    const pane = el('ai-managed-chat');
    if (!pane || !window.aiFree?.ai?.managedChat) return;
    const surface = mountChatViewport(el('ai-managed-viewport-host'), 'ai-managed-messages', 'ai-managed-message-list', '子对话消息');
    managedChatUi.messages = surface.messages;
    managedChatUi.resetScroll = bindChatScroll(surface);
    el('ai-managed-back').addEventListener('click', closeManagedView);
    pane.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented) closeManagedView();
    });
    const offChange = window.aiFree.ai.onManagedChatChanged?.(scheduleManagedRefresh);
    const offAccount = window.aiFree.account?.onSessionUpdated?.(() => {
      if (managedChatUi.view) closeManagedView();
      void refreshManagedParent();
    });
    window.addEventListener('pagehide', () => {
      offAccount?.();
      offChange?.();
      window.clearTimeout(managedChatUi.timer);
    }, { once: true });
    void refreshManagedParent();
  }

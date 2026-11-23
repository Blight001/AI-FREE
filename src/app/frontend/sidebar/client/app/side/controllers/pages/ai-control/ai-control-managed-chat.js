  const managedStatusNames = {
    idle: '待发送', running: '运行中', stopping: '正在停止', paused: '已暂停',
    completed: '已完成', failed: '失败', needs_review: '需核验',
  };
  const managedChatUi = { view: '', session: null, focus: null, parentPosition: null, timer: null, parentDirty: false, revision: 0 };

  async function managedChatCall(action, args = {}) {
    const result = await window.aiFree.ai.managedChat({ action, ...args });
    if (!result?.ok) throw new Error(result?.error?.message || '无法读取子对话');
    return result.data;
  }

  function managedChatError(error) {
    if (managedChatUi.view) el('ai-managed-status').textContent = error.message;
  }

  function drawManagedCards(container, sessions, empty = '') {
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
    container.replaceChildren(...(buttons.length ? buttons : empty ? [empty] : []));
    container.hidden = !buttons.length && !empty;
    if (active) buttons.find((button) => button.dataset.managedSessionId === active)?.focus();
  }

  async function refreshManagedParent() {
    const target = el('ai-managed-parent-cards');
    if (!target || !window.aiFree?.ai?.managedChat) return;
    const parentId = state.currentSession?.id;
    if (!parentId) return drawManagedCards(target, []);
    try {
      const data = await managedChatCall('list', { parent_id: parentId });
      if (state.currentSession?.id === parentId) drawManagedCards(target, data.sessions);
    } catch {
      if (state.currentSession?.id === parentId) drawManagedCards(target, []);
    }
  }

  function markManagedPane(open) {
    const pane = el('ai-managed-chat');
    pane.hidden = !open;
    for (const node of pane.parentElement.children) {
      if (node !== pane) node.inert = open;
    }
  }

  function createManagedMessage(message) {
    const article = document.createElement('article');
    article.className = 'ai-managed-message';
    const author = document.createElement('strong');
    author.textContent = message.role === 'user' ? '你' : 'AI';
    const body = document.createElement('div');
    if (message.role === 'assistant') renderMarkdownInto(body, message.content);
    else body.textContent = message.content;
    article.append(author, body);
    return article;
  }

  function renderManagedMessages(messages) {
    const container = el('ai-managed-messages');
    const signature = JSON.stringify(messages);
    if (container.managedSignature === signature) return;
    const follow = container.scrollHeight - container.scrollTop - container.clientHeight < 36;
    container.replaceChildren(...messages.map(createManagedMessage));
    container.managedSignature = signature;
    if (follow) container.scrollTop = container.scrollHeight;
  }

  function renderManagedSession(data) {
    managedChatUi.session = data;
    el('ai-managed-title').textContent = data.title;
    el('ai-managed-status').textContent = managedStatusNames[data.status] || data.status;
    renderManagedMessages(data.messages);
    const running = data.status === 'running';
    const locked = data.status === 'stopping' || data.status === 'paused';
    const model = el('ai-managed-model');
    model.value = data.modelId;
    model.disabled = running || locked;
    el('ai-managed-input').disabled = locked;
    el('ai-managed-send').disabled = locked;
    el('ai-managed-send').textContent = running ? '插话' : '发送';
    el('ai-managed-stop').hidden = !running;
    el('ai-managed-resume').hidden = data.status !== 'paused';
  }

  async function refreshManagedView() {
    const view = managedChatUi.view;
    const revision = ++managedChatUi.revision;
    if (!view) return;
    if (view === 'directory') {
      const { sessions } = await managedChatCall('list');
      if (managedChatUi.revision === revision) drawManagedCards(el('ai-managed-directory'), sessions, '暂无任务');
      return;
    }
    const data = await managedChatCall('status', { session_id: view });
    if (managedChatUi.revision === revision) renderManagedSession(data);
  }

  async function openManagedView(view) {
    if (!managedChatUi.view) {
      managedChatUi.focus = document.activeElement;
      managedChatUi.parentPosition = { id: state.currentSession?.id, top: el('ai-chat-messages').scrollTop };
    }
    managedChatUi.view = view;
    managedChatUi.session = null;
    const directory = view === 'directory';
    markManagedPane(true);
    el('ai-managed-title').textContent = directory ? '任务运行' : '子对话';
    el('ai-managed-status').textContent = '';
    el('ai-managed-directory').hidden = !directory;
    el('ai-managed-messages').hidden = directory;
    el('ai-managed-composer').hidden = directory;
    el('ai-managed-input').value = '';
    el('ai-managed-back').focus();
    renderManagedMessages([]);
    await refreshManagedView();
    if (!directory) {
      const { models } = await managedChatCall('models');
      if (managedChatUi.view !== view) return;
      const model = el('ai-managed-model');
      model.replaceChildren(...models.map(({ id, name }) => new Option(name || id, id)));
      model.value = managedChatUi.session?.modelId || '';
    }
  }

  function closeManagedView() {
    const focus = managedChatUi.focus;
    managedChatUi.revision++;
    managedChatUi.view = '';
    managedChatUi.session = null;
    markManagedPane(false);
    const position = managedChatUi.parentPosition;
    if (position && position.id === state.currentSession?.id) el('ai-chat-messages').scrollTop = position.top;
    const focusTarget = focus?.isConnected ? focus : el('ai-managed-tasks');
    focusTarget.focus({ preventScroll: true });
    managedChatUi.parentPosition = null;
    managedChatUi.focus = null;
  }

  async function operateManagedChild(action) {
    const session = managedChatUi.session;
    if (!session) return;
    const input = el('ai-managed-input');
    const args = { wait_ms: 0 };
    if (action === 'send') {
      if (!input.value.trim()) return;
      args.content = input.value;
      args.request_key = crypto.randomUUID();
      if (session.status === 'running') {
        action = 'insert';
        args.run_id = session.runId;
      } else args.session_id = session.sessionId;
    } else if (action === 'select_model') {
      args.session_id = session.sessionId;
      args.model_id = el('ai-managed-model').value;
    } else args.run_id = session.runId;
    await managedChatCall(action, args);
    if (managedChatUi.view === session.sessionId && args.content === input.value) input.value = '';
    await refreshManagedView();
  }

  function scheduleManagedRefresh(event) {
    if (event.parentId && event.parentId === state.currentSession?.id) managedChatUi.parentDirty = true;
    if (!managedChatUi.parentDirty && managedChatUi.view !== event.sessionId && managedChatUi.view !== 'directory') return;
    if (managedChatUi.timer) return;
    managedChatUi.timer = window.setTimeout(() => {
      managedChatUi.timer = null;
      if (managedChatUi.parentDirty) void refreshManagedParent();
      managedChatUi.parentDirty = false;
      void refreshManagedView().catch(managedChatError);
    }, 90);
  }

  function bindManagedChat() {
    const tasks = el('ai-managed-tasks');
    if (!tasks || !window.aiFree?.ai?.managedChat) return;
    tasks.addEventListener('click', () => void openManagedView('directory').catch(managedChatError));
    el('ai-managed-back').addEventListener('click', closeManagedView);
    el('ai-managed-chat').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeManagedView();
    });
    el('ai-managed-composer').addEventListener('submit', (event) => {
      event.preventDefault();
      void operateManagedChild('send').catch(managedChatError);
    });
    el('ai-managed-stop').addEventListener('click', () => void operateManagedChild('stop').catch(managedChatError));
    el('ai-managed-resume').addEventListener('click', () => void operateManagedChild('resume').catch(managedChatError));
    el('ai-managed-model').addEventListener('change', () => void operateManagedChild('select_model').catch(managedChatError));
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

  function normalizeBrowserIds(list) {
    return [...new Set((Array.isArray(list) ? list : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean))];
  }

  function sessionBrowserIds(session) {
    return normalizeBrowserIds(Array.isArray(session?.browserConnectionIds)
      ? session.browserConnectionIds
      : (session?.browserConnectionId ? [session.browserConnectionId] : [])).slice(0, 1);
  }

  function currentMessages() {
    return state.messages;
  }

  function aiInputHasActiveDraft() {
    const input = el('ai-chat-input');
    return input === document.activeElement
      && (state.aiInputComposing || Boolean(input?.textContent));
  }

  function flushDeferredAiControlRefresh() {
    if (aiInputHasActiveDraft()) return;
    if (state.accountSessionRefreshQueued) {
      state.accountSessionRefreshQueued = false;
      void loadModels();
      void loadMcpTools();
      void bootstrapHistory();
    }
  }

  function makeSessionId() {
    try {
      if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    } catch (_) {}
    return `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function historyLocalScope() {
    const username = String(el('account-username-display')?.value || '').trim();
    const deviceId = String(el('device-id')?.value || '').trim();
    return username || deviceId || 'local';
  }

  function readLocalHistoryStore() {
    try {
      const raw = localStorage.getItem(HISTORY_LS_PREFIX + historyLocalScope());
      if (!raw) return { version: 1, sessions: [], currentId: '' };
      const data = JSON.parse(raw);
      return {
        version: 1,
        sessions: Array.isArray(data?.sessions) ? data.sessions : [],
        currentId: String(data?.currentId || ''),
      };
    } catch (_) {
      return { version: 1, sessions: [], currentId: '' };
    }
  }

  function writeLocalHistoryStore(store) {
    try {
      localStorage.setItem(HISTORY_LS_PREFIX + historyLocalScope(), JSON.stringify({
        version: 1,
        sessions: Array.isArray(store?.sessions) ? store.sessions : [],
        currentId: String(store?.currentId || ''),
      }));
      return true;
    } catch (error) {
      console.warn('[AI 控制] localStorage 历史写入失败:', error?.message || error);
      return false;
    }
  }

  function selectionString(value, fallback = '') {
    return String(value || fallback);
  }

  function selectionTimestamp(value) {
    return Number(value) || Date.now();
  }

  function sessionSummaryLocal(session) {
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    return {
      id: selectionString(session?.id),
      title: selectionString(session?.title, '新对话'),
      titleGenerated: session?.titleGenerated === true,
      modelId: selectionString(session?.modelId),
      browserConnectionId: selectionString(session?.browserConnectionId),
      browserConnectionIds: sessionBrowserIds(session),
      automationCardId: '',
      preview: selectionString(session?.preview),
      messageCount: messages.length,
      createdAt: selectionTimestamp(session?.createdAt),
      updatedAt: selectionTimestamp(session?.updatedAt),
      pinnedAt: Number(session?.pinnedAt) || 0,
    };
  }

  function upsertLocalSession(session) {
    if (!session?.id) return;
    const store = readLocalHistoryStore();
    const next = {
      ...session,
      messages: Array.isArray(session.messages) ? session.messages : [],
      updatedAt: Date.now(),
    };
    // 对话内容被全部撤回/删除后，也要清掉之前落盘的旧记录。
    if (!next.messages.length) {
      deleteLocalSession(next.id);
      return;
    }
    const index = store.sessions.findIndex((item) => String(item.id) === String(next.id));
    if (index >= 0) store.sessions[index] = next;
    else store.sessions.unshift(next);
    store.sessions = store.sessions
      .filter((item) => Array.isArray(item.messages) && item.messages.length)
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    store.currentId = next.id;
    writeLocalHistoryStore(store);
  }

  function deleteLocalSession(sessionId) {
    const store = readLocalHistoryStore();
    const id = String(sessionId || '');
    store.sessions = store.sessions.filter((item) => String(item.id) !== id);
    if (store.currentId === id) store.currentId = store.sessions[0]?.id || '';
    writeLocalHistoryStore(store);
    return store;
  }

  function renameLocalSession(sessionId, title) {
    const store = readLocalHistoryStore();
    const id = String(sessionId || '');
    const session = store.sessions.find((item) => String(item.id) === id);
    if (!session) return null;
    session.title = String(title || '').trim().slice(0, 40);
    session.titleGenerated = true;
    writeLocalHistoryStore(store);
    return session;
  }

  function setLocalHistoryPin(id, pinnedAt) {
    const store = readLocalHistoryStore();
    const session = store.sessions.find((item) => String(item.id) === id);
    if (!session) return false;
    session.pinnedAt = pinnedAt;
    if (!writeLocalHistoryStore(store)) throw new Error('未能保存本地对话的置顶状态');
    return true;
  }

  function getLocalSession(sessionId) {
    const store = readLocalHistoryStore();
    const found = store.sessions.find((item) => String(item.id) === String(sessionId || ''));
    if (!found) return null;
    store.currentId = found.id;
    writeLocalHistoryStore(store);
    return found;
  }

  function setStatus(message, type = 'error') {
    const target = el('ai-chat-status');
    if (target) {
      target.textContent = '';
      target.dataset.type = '';
    }

    const text = String(message || '').trim();
    if (!text) return;

    const handlers = {
      warning: window.MessageModal?.showWarningMessage,
      info: window.MessageModal?.showInfoMessage,
      success: window.MessageModal?.showSuccessMessage,
      error: window.MessageModal?.showErrorMessage,
    };
    const handler = handlers[type] || handlers.error;
    if (handler) handler.call(window.MessageModal, text);
    else console.error('[AI 对话]', text);
  }

  function selectedModelIsCustom() {
    const option = el('ai-chat-model')?.selectedOptions?.[0];
    return option?.dataset?.customApi === 'true';
  }

  function confirmDestructiveAction(message, onConfirm) {
    const run = async () => {
      try {
        await onConfirm();
      } catch (error) {
        setStatus(error?.message || String(error), 'warning');
      }
    };
    const modal = window.MessageModal;
    if (modal?.showConfirmDialog) {
      modal.showConfirmDialog(message, run, null, 'warning');
      return;
    }
    // 弹窗模块尚未就绪时保留浏览器原生确认，避免无确认直接执行破坏性操作。
    if (typeof window.confirm === 'function' && window.confirm(message)) {
      void run();
    }
  }

  function isQuotaFailure(message) {
    return /AI\s*对话额度(?:不足|已用尽)|对话额度(?:不足|已用尽)|额度(?:不足|已用尽).*联系管理员/.test(String(message || ''));
  }

  function isQuotaExhausted(quota = state.quota) {
    if (!quota || quota.unlimited === true) return false;
    const total = Number(quota.quota);
    const used = Number(quota.used || 0);
    const remaining = Number(quota.remaining ?? (total - used));
    return Number.isFinite(remaining) && remaining <= 0;
  }

  function showChatBusinessError(message) {
    const text = String(message || '对话请求失败');
    if (window.MessageModal?.showWarningMessage) {
      window.MessageModal.showWarningMessage(text);
      return;
    }
    setStatus(text);
  }

  function formatQuota(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number)) return '0';
    if (Number.isInteger(number)) return String(number);
    return number.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
  }

  function selectedModelMultiplier() {
    const option = el('ai-chat-model')?.selectedOptions?.[0];
    const multiplier = Number(option?.dataset?.quotaMultiplier || 0);
    return Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 0;
  }

  function provisionalTitle(text) {
    const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return '新对话';
    return cleaned.slice(0, 20) + (cleaned.length > 20 ? '…' : '');
  }

  function sanitizeGeneratedTitle(raw) {
    let title = String(raw || '').trim();
    title = title.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
    title = title
      .replace(/^["'「『【\[]+|["'」』】\]]+$/g, '')
      .replace(/^(标题|题目)[:：\s]*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!title) return '';
    return title.slice(0, 24);
  }

  function formatRelativeTime(ts) {
    const time = Number(ts) || 0;
    if (!time) return '';
    const diff = Date.now() - time;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    if (diff < 86_400_000 * 7) return `${Math.floor(diff / 86_400_000)} 天前`;
    try {
      return new Date(time).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (_) {
      return '';
    }
  }

  /* ---------------- 自定义下拉 ---------------- */

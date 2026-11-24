/**
 * AI 对话历史本地存储（按登录账号隔离）
 */
const crypto = require('crypto');
const { AppError } = require('../../contracts/ipc-result');
const { parseChatQuotaUsed } = require('../../shared/quota-display');
const { normalizeFileArtifacts } = require('../features/ai-chat/workspace-file-artifacts');
const { createAiChatHistoryFileStore } = require('./ai-chat-history-file-store');
const { createAiChatHistoryMemoryStore } = require('./ai-chat-history-memory-store');

function accountScope(credentials = {}) {
  const key = String(credentials.key || credentials.credential || '').trim();
  const username = String(credentials.username || '').trim();
  const deviceId = String(credentials.deviceId || credentials.device_id || '').trim();
  const seed = [key, username, deviceId].filter(Boolean).join('|') || 'anonymous';
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 20);
}

const DEFAULT_HISTORY_CONTEXT = Object.freeze({
  accountScope,
  now: () => Date.now(),
  randomUUID: () => crypto.randomUUID(),
});

function normalizeHistoryContext(options = {}) {
  return {
    accountScope: options.accountScope || DEFAULT_HISTORY_CONTEXT.accountScope,
    now: options.now || DEFAULT_HISTORY_CONTEXT.now,
    randomUUID: options.randomUUID || DEFAULT_HISTORY_CONTEXT.randomUUID,
  };
}

function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const messages = [];
  for (const item of raw) {
    const message = sanitizeMessage(item);
    if (message) messages.push(message);
  }
  return messages;
}

function sanitizeMessage(item) {
  if (!item || typeof item !== 'object') return null;
  const role = String(item.role || '').trim().toLowerCase();
  if (!['system', 'user', 'assistant', 'tool'].includes(role)) return null;
  const message = {
    role,
    content: typeof item.content === 'string' ? item.content : String(item.content || ''),
  };
  if (role === 'assistant') appendAssistantHistory(message, item);
  if (role === 'tool') appendToolHistory(message, item);
  if (role === 'user' && Array.isArray(item.attachmentPaths)) {
    message.attachmentPaths = item.attachmentPaths
      .map((value) => String(value || '').trim()).filter(Boolean).slice(0, 16);
    const references = normalizeFileArtifacts(item.artifactReferences)
      .filter((artifact) => message.attachmentPaths.includes(artifact.path));
    if (references.length) message.artifactReferences = references;
  }
  if (role === 'user' && Array.isArray(item.inlineAttachments)) {
    message.inlineAttachments = item.inlineAttachments
      .filter((entry) => entry && typeof entry.path === 'string' && typeof entry.marker === 'string')
      .slice(0, 16)
      .map((entry) => ({ path: entry.path.slice(0, 4096), marker: entry.marker.slice(0, 512) }));
  }
  return message;
}

function appendAssistantHistory(message, item) {
  if (Number.isSafeInteger(item.turn_duration_ms) && item.turn_duration_ms >= 0) {
    message.turn_duration_ms = item.turn_duration_ms;
  }
  if (Array.isArray(item.tool_calls) && item.tool_calls.length) message.tool_calls = item.tool_calls;
  if (typeof item.reasoning === 'string') message.reasoning = item.reasoning;
  if (Array.isArray(item.tool_events)) {
    message.tool_events = item.tool_events.map(sanitizeToolEvent);
  }
  if (Array.isArray(item.trace_events)) {
    message.trace_events = item.trace_events.map(sanitizeTraceEvent);
  }
  const artifacts = normalizeFileArtifacts(item.artifacts);
  if (artifacts.length) message.artifacts = artifacts;
}

function compactHistoryValue(value) {
  let text = '';
  try { text = typeof value === 'string' ? value : JSON.stringify(value, null, 2); } catch (_) { text = String(value ?? ''); }
  if (typeof text !== 'string') text = String(value ?? '');
  return text;
}

function sanitizeToolEvent(entry) {
  return {
    id: String(entry?.id || ''),
    name: String(entry?.name || '工具'),
    status: String(entry?.status || 'success'),
    arguments: compactHistoryValue(entry?.arguments),
    result: compactHistoryValue(entry?.result),
    duration_ms: sanitizeDurationMs(entry?.duration_ms),
  };
}

function sanitizeDurationMs(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 0 ? duration : 0;
}

function sanitizeTraceEvent(entry, index) {
  const type = normalizeTraceType(entry);
  if (type !== 'tool') {
    return sanitizeTextTraceEvent(entry, type);
  }
  return sanitizeToolTraceEvent(entry, index, type);
}

function normalizeTraceType(entry) {
  return ['reasoning', 'tool', 'step'].includes(entry?.type) ? entry.type : 'step';
}

function sanitizeTextTraceEvent(entry, type) {
  return { type, round: Number(entry?.round) || 0, content: String(entry?.content || '') };
}

function sanitizeToolTraceEvent(entry, index, type) {
  return {
    type,
    round: Number(entry?.round) || 0,
    tool: sanitizeTraceTool(entry?.tool, index),
  };
}

function sanitizeTraceTool(tool, index) {
  return {
    id: String(tool?.id || `tool-${index}`),
    name: String(tool?.name || '工具'),
    status: String(tool?.status || 'success'),
    arguments: compactHistoryValue(tool?.arguments),
    result: compactHistoryValue(tool?.result),
    duration_ms: sanitizeDurationMs(tool?.duration_ms),
  };
}

function appendToolHistory(message, item) {
  message.tool_call_id = String(item.tool_call_id || '');
  if (item.name) message.name = String(item.name);
}

function previewFromMessages(messages) {
  const firstUser = (messages || []).find((m) => m.role === 'user' && String(m.content || '').trim());
  if (!firstUser) return '';
  return String(firstUser.content).replace(/\s+/g, ' ').trim().slice(0, 80);
}

function normalizeBrowserConnectionIds(raw = {}) {
  const list = Array.isArray(raw.browserConnectionIds)
    ? raw.browserConnectionIds
    : (raw.browserConnectionId ? [raw.browserConnectionId] : []);
  return [...new Set(list.map((value) => String(value || '').trim()).filter(Boolean))];
}

const normalizePinnedAt = (value) => Number.isSafeInteger(value) && value > 0 ? value : 0;

function normalizeSession(raw = {}, context = DEFAULT_HISTORY_CONTEXT) {
  const id = String(raw.id || '').trim() || context.randomUUID();
  const messages = sanitizeMessages(raw.messages);
  const title = String(raw.title || '').trim() || '新对话';
  const now = context.now();
  const browserConnectionIds = normalizeBrowserConnectionIds(raw);
  return {
    id,
    title: title.slice(0, 40),
    titleGenerated: raw.titleGenerated === true,
    modelId: String(raw.modelId || '').trim(),
    browserConnectionId: browserConnectionIds[0] || '',
    browserConnectionIds,
    automationCardId: String(raw.automationCardId || '').trim(),
    messages,
    quotaUsed: parseChatQuotaUsed(raw.quotaUsed) ?? 0,
    preview: String(raw.preview || previewFromMessages(messages) || '').slice(0, 80),
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || now,
    pinnedAt: normalizePinnedAt(raw.pinnedAt),
  };
}

function sessionSummary(session) {
  return {
    id: session.id,
    title: session.title,
    titleGenerated: session.titleGenerated === true,
    modelId: session.modelId || '',
    browserConnectionId: session.browserConnectionId || '',
    browserConnectionIds: Array.isArray(session.browserConnectionIds) ? session.browserConnectionIds : [],
    automationCardId: session.automationCardId || '',
    preview: session.preview || '',
    messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    pinnedAt: session.pinnedAt,
  };
}

function normalizedMessageCount(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function normalizeSessionSummary(raw = {}, context = DEFAULT_HISTORY_CONTEXT) {
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  const messageCount = normalizedMessageCount(raw.messageCount, messages.length);
  const browserConnectionIds = normalizeBrowserConnectionIds(raw);
  return {
    id: String(raw.id || '').trim(),
    title: String(raw.title || '').trim().slice(0, 40) || '新对话',
    titleGenerated: raw.titleGenerated === true,
    modelId: String(raw.modelId || '').trim(),
    browserConnectionId: browserConnectionIds[0] || '',
    browserConnectionIds,
    automationCardId: String(raw.automationCardId || '').trim(),
    preview: String(raw.preview || previewFromMessages(messages) || '').slice(0, 80),
    messageCount,
    createdAt: Number(raw.createdAt) || context.now(),
    updatedAt: Number(raw.updatedAt) || context.now(),
    pinnedAt: normalizePinnedAt(raw.pinnedAt),
  };
}

function sortedIndexEntries(index, context) {
  return index.sessions.map((item) => normalizeSessionSummary(item, context))
    .filter((item) => item.id)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function replaceIndexEntry(index, entry) {
  const sessions = index.sessions.filter((item) => String(item.id) !== String(entry.id));
  sessions.push(entry);
  index.sessions = sessions.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
}

function removeIndexEntry(index, id) {
  index.sessions = index.sessions.filter((item) => String(item.id) !== String(id));
  if (index.currentId === id) index.currentId = String(index.sessions[0]?.id || '');
}

function listSessions(credentials, context, storage) {
  const index = storage.readIndex(context.accountScope(credentials));
  const sessions = sortedIndexEntries(index, context);
  return { ok: true, sessions, currentId: index.currentId || sessions[0]?.id || '' };
}

function getSession(credentials, sessionId, options, context, storage) {
  const scope = context.accountScope(credentials);
  const id = String(sessionId || '').trim();
  const index = storage.readIndex(scope);
  if (!index.sessions.some((item) => String(item.id) === id)) return { ok: false, message: '对话不存在' };
  const raw = storage.readSession(scope, id);
  if (!raw) return { ok: false, message: '对话不存在' };
  const session = normalizeSession(raw, context);
  if (options?.setCurrent !== false) {
    index.currentId = session.id;
    storage.writeIndex(scope, index);
  }
  return { ok: true, session };
}

function saveSession(credentials, rawSession, options, context, storage) {
  const scope = context.accountScope(credentials);
  const index = storage.readIndex(scope);
  const session = normalizeSession(rawSession, context);
  session.preview = previewFromMessages(session.messages) || session.preview || '';
  session.updatedAt = context.now();
  const existingEntry = index.sessions.find((item) => String(item.id) === session.id);
  if (!session.messages.length && options?.allowEmpty !== true) {
    return removeEmptySession(scope, index, session, existingEntry, storage);
  }
  const existing = existingEntry ? storage.readSession(scope, session.id) : null;
  if (existing) {
    session.pinnedAt = normalizePinnedAt(existing.pinnedAt);
    session.quotaUsed = Math.max(session.quotaUsed, parseChatQuotaUsed(existing.quotaUsed) ?? 0);
  }
  if (!storage.writeSession(scope, session)) return historyWriteFailure(session);
  replaceIndexEntry(index, storage.indexEntry(scope, sessionSummary(session)));
  if (options?.setCurrent !== false) index.currentId = session.id;
  if (!storage.writeIndex(scope, index)) return historyWriteFailure(session);
  return { ok: true, session, summary: sessionSummary(session) };
}

function historyWriteFailure(session) {
  return { ok: false, message: '对话历史写入本地失败', session, summary: sessionSummary(session) };
}

function removeEmptySession(scope, index, session, existingEntry, storage) {
  if (!existingEntry) return { ok: true, session, summary: sessionSummary(session), skipped: true };
  if (!storage.deleteSession(scope, session.id)) return historyWriteFailure(session);
  removeIndexEntry(index, session.id);
  if (!storage.writeIndex(scope, index)) return historyWriteFailure(session);
  return { ok: true, session, summary: sessionSummary(session), removed: true, currentId: index.currentId };
}

function deleteSession(credentials, sessionId, context, storage) {
  const scope = context.accountScope(credentials);
  const id = String(sessionId || '').trim();
  const index = storage.readIndex(scope);
  if (!index.sessions.some((item) => String(item.id) === id)) return { ok: false, message: '对话不存在' };
  if (!storage.deleteSession(scope, id)) return { ok: false, message: '对话历史删除失败' };
  removeIndexEntry(index, id);
  if (!storage.writeIndex(scope, index)) return { ok: false, message: '对话历史索引更新失败' };
  return { ok: true, currentId: index.currentId, sessions: sortedIndexEntries(index, context) };
}

function renameSession(credentials, sessionId, rawTitle, context, storage) {
  const scope = context.accountScope(credentials);
  const id = String(sessionId || '').trim();
  const title = String(rawTitle || '').trim().slice(0, 40);
  if (!title) return { ok: false, message: '对话名称不能为空' };
  const index = storage.readIndex(scope);
  if (!index.sessions.some((item) => String(item.id) === id)) return { ok: false, message: '对话不存在' };
  const raw = storage.readSession(scope, id);
  if (!raw) return { ok: false, message: '对话不存在' };
  const session = normalizeSession(raw, context);
  session.title = title;
  session.titleGenerated = true;
  if (!storage.writeSession(scope, session)) return { ok: false, message: '对话历史写入本地失败' };
  replaceIndexEntry(index, storage.indexEntry(scope, sessionSummary(session)));
  if (!storage.writeIndex(scope, index)) return { ok: false, message: '对话索引更新失败' };
  return { ok: true, session, summary: sessionSummary(session) };
}

function setSessionPinned(credentials, id, pinned, context, storage) {
  const scope = context.accountScope(credentials);
  const index = storage.readIndex(scope);
  if (!index.sessions.some((item) => String(item.id) === String(id))) {
    throw new AppError('AI_HISTORY_NOT_FOUND', '对话不存在');
  }
  const raw = storage.readSession(scope, id);
  if (!raw) throw new AppError('AI_HISTORY_NOT_FOUND', '对话不存在');
  const session = normalizeSession(raw, context);
  const previous = normalizePinnedAt(session.pinnedAt);
  const pinnedAt = pinned ? (previous || context.now()) : 0;
  if (pinnedAt !== previous) {
    session.pinnedAt = pinnedAt;
    if (!storage.writeSession(scope, session)) {
      throw new AppError('AI_HISTORY_PIN_WRITE_FAILED', '未能保存对话置顶状态', { retryable: true });
    }
    replaceIndexEntry(index, storage.indexEntry(scope, sessionSummary(session)));
    if (!storage.writeIndex(scope, index)) {
      throw new AppError('AI_HISTORY_PIN_WRITE_FAILED', '未能保存对话索引', { retryable: true });
    }
  }
  return { id, pinnedAt };
}

function createSession(credentials, partial = {}, context, storage) {
  const session = normalizeSession({
    id: context.randomUUID(), title: '新对话', titleGenerated: false,
    modelId: partial.modelId || '',
    browserConnectionId: partial.browserConnectionId || '',
    browserConnectionIds: Array.isArray(partial.browserConnectionIds) ? partial.browserConnectionIds : [],
    automationCardId: partial.automationCardId || '', messages: [],
    createdAt: context.now(), updatedAt: context.now(),
  }, context);
  const scope = context.accountScope(credentials);
  const index = storage.readIndex(scope);
  index.currentId = session.id;
  if (!storage.writeIndex(scope, index)) return { ok: false, message: '无法保存当前对话状态', session };
  return { ok: true, session, summary: sessionSummary(session) };
}

function setCurrent(credentials, sessionId, context, storage) {
  const scope = context.accountScope(credentials);
  const index = storage.readIndex(scope);
  const id = String(sessionId || '').trim();
  if (id && !index.sessions.some((item) => String(item.id) === id)) {
    return { ok: false, message: '对话不存在' };
  }
  index.currentId = id;
  if (!storage.writeIndex(scope, index)) return { ok: false, message: '无法保存当前对话状态' };
  return { ok: true, currentId: id };
}

function createMemoryStorage(options) {
  return createAiChatHistoryMemoryStore(options);
}

function createRepositoryMethods(context, storage) {
  return {
    createSession: (credentials, partial) => createSession(credentials, partial, context, storage),
    deleteSession: (credentials, id) => deleteSession(credentials, id, context, storage),
    getSession: (credentials, id, options = {}) => getSession(credentials, id, options, context, storage),
    listSessions: (credentials) => listSessions(credentials, context, storage),
    renameSession: (credentials, id, title) => renameSession(credentials, id, title, context, storage),
    saveSession: (credentials, session, options = {}) => saveSession(credentials, session, options, context, storage),
    setSessionPinned: (credentials, id, pinned) => setSessionPinned(credentials, id, pinned, context, storage),
    setCurrent: (credentials, id) => setCurrent(credentials, id, context, storage),
  };
}

function provisionalTitleFromText(text) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '新对话';
  return cleaned.slice(0, 20) + (cleaned.length > 20 ? '…' : '');
}

function createAiChatHistoryRepository(options = {}) {
  const context = normalizeHistoryContext(options);
  const injectedStore = typeof options.readStore === 'function' || typeof options.writeStore === 'function';
  const storage = options.storage || (injectedStore
    ? createMemoryStorage(options)
    : createAiChatHistoryFileStore({
      historyRootDir: options.historyRootDir,
      fs: options.fs,
      path: options.path,
      normalizeSession: (raw) => normalizeSession(raw, context),
      summarizeSession: (session) => sessionSummary(session),
    }));
  return createRepositoryMethods(context, storage);
}

let defaultRepository;
function getDefaultRepository() {
  if (!defaultRepository) defaultRepository = createAiChatHistoryRepository();
  return defaultRepository;
}

module.exports = {
  createAiChatHistoryRepository,
  listSessions: (...args) => getDefaultRepository().listSessions(...args),
  getSession: (...args) => getDefaultRepository().getSession(...args),
  saveSession: (...args) => getDefaultRepository().saveSession(...args),
  deleteSession: (...args) => getDefaultRepository().deleteSession(...args),
  renameSession: (...args) => getDefaultRepository().renameSession(...args),
  createSession: (...args) => getDefaultRepository().createSession(...args),
  setCurrent: (...args) => getDefaultRepository().setCurrent(...args),
  normalizeSession,
  sanitizeMessage,
  sanitizeToolEvent,
  provisionalTitleFromText,
};

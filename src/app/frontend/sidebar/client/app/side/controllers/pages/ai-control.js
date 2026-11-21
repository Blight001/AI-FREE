const state = {
  messages: [],
  sessionList: [],
  currentSession: null,
  mcpToolsError: '',
  mcpToolsLoading: false,
  currentCardId: '',
  sharedAutomationCardId: '',
  automationCards: [],
  automationCardsLoading: false,
  automationCardsRefreshQueued: false,
  automationCardsQueuedPreferredId: '',
  automationCardsSnapshot: '',
  automationCardsError: '',
  accountAuthenticated: false,
  loading: false,
  streamOutput: readStreamOutputPreference(),
  stopping: false,
  activeRequestId: '',
  attachmentPaths: [],
  chatMentions: [],
  mcpTools: [],
  workspaceFiles: [],
  generatingTitle: false,
  quota: null,
  lastQuotaCost: null,
  customApiHasKey: false,
  customApiSaving: false,
  aiInputComposing: false,
  aiInputCompositionBase: '',
  aiInputCompositionDraft: '',
  aiInputCompositionCancelled: false,
  accountSessionRefreshQueued: false,
  historySaveChains: new Map(),
  historySaveLatestPayloads: new Map(),
};

const HISTORY_LS_PREFIX = 'ai-free.ai-chat-history.v1.';
const STREAM_OUTPUT_STORAGE_KEY = 'ai-free.ai-chat-stream-output.v1';
function readStreamOutputPreference() {
  try { return localStorage.getItem(STREAM_OUTPUT_STORAGE_KEY) !== 'false'; } catch (_) { return true; }
}
const SEND_BUTTON_ICONS = {
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"></path><path d="M22 2 11 13"></path></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"></rect></svg>',
};
const el = (id) => document.getElementById(id);

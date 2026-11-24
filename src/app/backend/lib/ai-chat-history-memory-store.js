'use strict';

function emptyStore() {
  return { version: 1, currentId: '', sessions: [] };
}

function createAiChatHistoryMemoryStore(options = {}) {
  const readStore = options.readStore || (() => emptyStore());
  const writeStore = options.writeStore || (() => true);

  function read(scope) {
    const store = readStore(scope);
    if (!store || typeof store !== 'object') return emptyStore();
    return { ...store, sessions: Array.isArray(store.sessions) ? store.sessions : [] };
  }

  function write(scope, store) {
    return writeStore(scope, store) !== false;
  }

  function readIndex(scope) {
    const store = read(scope);
    return { version: 2, currentId: String(store.currentId || ''), sessions: store.sessions };
  }

  function readSession(scope, id) {
    return read(scope).sessions.find((session) => String(session?.id || '') === String(id || '')) || null;
  }

  function writeSession(scope, session) {
    const store = read(scope);
    const index = store.sessions.findIndex((item) => String(item?.id || '') === String(session.id));
    if (index < 0) store.sessions.unshift(session);
    else store.sessions[index] = session;
    return write(scope, store);
  }

  function writeIndex(scope, index) {
    const store = read(scope);
    store.currentId = String(index.currentId || '');
    return write(scope, store);
  }

  function deleteSession(scope, id) {
    const store = read(scope);
    store.sessions = store.sessions.filter((item) => String(item?.id || '') !== String(id));
    return write(scope, store);
  }

  return {
    deleteSession,
    indexEntry: (_scope, summary) => summary,
    readIndex,
    readSession,
    writeIndex,
    writeSession,
  };
}

module.exports = { createAiChatHistoryMemoryStore };
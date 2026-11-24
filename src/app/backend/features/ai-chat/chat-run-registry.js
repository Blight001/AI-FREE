'use strict';

function runKey(event, requestId) {
  return `${event?.sender?.id || 0}:${String(requestId || '').trim()}`;
}

function createChatRunRegistry() {
  const runs = new Map();
  const continuations = new WeakMap();

  function begin(event, requestId) {
    const key = runKey(event, requestId);
    continuations.delete(event?.sender);
    const previous = runs.get(key);
    if (previous) {
      previous.stopped = true;
      previous.controller.abort();
    }
    const controller = new AbortController();
    const run = { controller, insertedMessages: [], stopped: false, stoppedByUser: false, continuation: null };
    runs.set(key, run);
    return { key, run };
  }

  function insert(event, requestId, content) {
    const run = runs.get(runKey(event, requestId));
    if (!run || run.stopped) return { ok: false, message: '当前 AI 回复已经结束' };
    run.insertedMessages.push({ role: 'user', content });
    return { ok: true, queued: run.insertedMessages.length };
  }

  function stop(event, requestId) {
    const run = runs.get(runKey(event, requestId));
    if (!run) return { ok: true, stopped: false };
    run.stopped = true;
    run.stoppedByUser = true;
    run.controller.abort();
    return { ok: true, stopped: true };
  }

  function finish(key, run) {
    if (key && runs.get(key) === run) {
      runs.delete(key);
    }
  }

  function saveContinuation(event, key, run) {
    if (!event?.sender || runs.get(key) !== run || !run?.stoppedByUser || !run.continuation) return false;
    continuations.set(event.sender, { key, value: run.continuation });
    return true;
  }

  function getContinuation(event, requestId) {
    const entry = continuations.get(event?.sender);
    return entry?.key === runKey(event, requestId) ? entry.value : null;
  }

  return { begin, finish, get: (event, requestId) => runs.get(runKey(event, requestId)),
    insert, stop, saveContinuation, getContinuation, hasActiveRuns: () => runs.size > 0 };
}

module.exports = { createChatRunRegistry, runKey };

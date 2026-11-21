'use strict';

const { createChatApproval, chatError } = require('./chat-browser-target');

function runKey(event, requestId) {
  return `${event?.sender?.id || 0}:${String(requestId || '').trim()}`;
}

function createChatRunRegistry() {
  const runs = new Map();

  function begin(event, requestId) {
    const key = runKey(event, requestId);
    const previous = runs.get(key);
    if (previous) {
      previous.stopped = true;
      previous.controller.abort();
    }
    const controller = new AbortController();
    const run = { controller, approval: createChatApproval(controller.signal), insertedMessages: [], stopped: false };
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
    run.controller.abort();
    return { ok: true, stopped: true };
  }

  function finish(key, run) {
    if (key && runs.get(key) === run) {
      run.approval.cancel();
      runs.delete(key);
    }
  }

  function decide(event, requestId, id, accepted) {
    const run = runs.get(runKey(event, requestId));
    if (!run?.approval.decide(id, accepted)) return chatError('APPROVAL_EXPIRED', '该确认已失效');
    return { ok: true, data: { accepted } };
  }

  return { begin, decide, finish, get: (event, requestId) => runs.get(runKey(event, requestId)), insert, stop };
}

module.exports = { createChatRunRegistry, runKey };

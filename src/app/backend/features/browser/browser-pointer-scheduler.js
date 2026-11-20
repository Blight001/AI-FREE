'use strict';

function getOrCreate(map, key, create) {
  if (!map.has(key)) map.set(key, create());
  return map.get(key);
}

function releasedError() {
  return Object.assign(new Error('光标会话已结束，请重新接管。'), { code: 'BROWSER_POINTER_RELEASED' });
}

function createBrowserPointerScheduler() {
  const sessions = new Map();
  const lanes = new Map();

  function run(sessionId, pointerId, resource, dispatch) {
    const session = getOrCreate(sessions, sessionId, () => ({ controller: new AbortController(), pointers: new Map(), pending: new Set() }));
    const pointer = getOrCreate(session.pointers, pointerId, () => ({ position: null, pending: Promise.resolve() }));
    const { signal } = session.controller;
    const previous = lanes.get(resource);
    const start = previous ? Promise.all([previous, pointer.pending]) : pointer.pending;
    const work = start.then(() => {
      if (signal.aborted) throw releasedError();
      return dispatch(pointer, signal);
    });
    const settled = work.then(() => {}, () => {});
    pointer.pending = settled;
    lanes.set(resource, settled);
    session.pending.add(settled);
    void settled.then(() => {
      session.pending.delete(settled);
      if (lanes.get(resource) === settled) lanes.delete(resource);
    });
    return work;
  }

  async function release(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    session.controller.abort();
    await Promise.all(session.pending);
  }

  return { run, release };
}

module.exports = { createBrowserPointerScheduler };

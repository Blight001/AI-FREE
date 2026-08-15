(function installAutomationCanvasHistory(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AppShellAutomationCanvasHistory = Object.freeze(api);
})(typeof window === 'object' ? window : null, () => {
  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function serialized(value) {
    return JSON.stringify(value);
  }

  function createTimeline(limit = 100) {
    let present = null;
    let presentKey = '';
    let past = [];
    let future = [];

    function reset(value) {
      present = clone(value);
      presentKey = serialized(present);
      past = [];
      future = [];
    }

    function record(value) {
      const next = clone(value);
      const nextKey = serialized(next);
      if (nextKey === presentKey) return false;
      if (present !== null) past.push(present);
      if (past.length > limit) past = past.slice(-limit);
      present = next;
      presentKey = nextKey;
      future = [];
      return true;
    }

    function move(source, target) {
      if (!source.length) return null;
      target.push(present);
      present = source.pop();
      presentKey = serialized(present);
      return clone(present);
    }

    return Object.freeze({
      reset,
      record,
      undo: () => move(past, future),
      redo: () => move(future, past),
      canUndo: () => past.length > 0,
      canRedo: () => future.length > 0,
    });
  }

  function createClipboard(value) {
    return { ...clone(value), pasteCount: 0 };
  }

  function pasteClipboard(source, card) {
    const next = clone(card);
    source.pasteCount += 1;
    const originalId = source.step.id;
    const id = source.cut ? originalId : `${originalId}_copy_${Date.now().toString(36)}_${source.pasteCount}`;
    next.steps.push({ ...clone(source.step), id });
    next.flow.nodes.push({
      ...clone(source.node), id,
      x: source.node.x + 28 * source.pasteCount,
      y: source.node.y + 28 * source.pasteCount,
    });
    if (source.cut) {
      const ids = new Set(next.steps.map((step) => step.id));
      next.flow.edges.push(...source.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)));
      if (source.start) next.flow.start = id;
      source.cut = false;
    }
    return { card: next, id };
  }

  return { createClipboard, createTimeline, pasteClipboard };
});

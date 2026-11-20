'use strict';

// One scope belongs to one fixture. Register releases as soon as resources are
// allocated, so failed initialization follows the same cleanup path as success.
function createResourceScope() {
  const resources = new Map();
  let closing;
  const release = async () => {
    const failed = [];
    for (const [name, dispose] of [...resources].reverse()) {
      try { await dispose({ failed: [...failed] }); }
      catch (_) { failed.push(name); }
    }
    return { ok: failed.length === 0, failed };
  };
  return {
    defer(name, dispose) {
      if (closing) throw new Error('RESOURCE_SCOPE_CLOSED');
      if (resources.has(name)) throw new Error('DUPLICATE_RESOURCE');
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || typeof dispose !== 'function') throw new Error('INVALID_RESOURCE');
      resources.set(name, dispose);
    },
    close() { closing ||= Promise.resolve().then(release); return closing; },
  };
}

module.exports = { createResourceScope };

'use strict';

const { isDeepStrictEqual } = require('util');

// All desired configuration writes share the same queue as navigation and restart.
// appliedProfile is the redacted launch snapshot and changes only after a new launch.
function updateProfileConfiguration(runtime, profileId, update, options = {}) {
  const captured = typeof update === 'function' ? update : structuredClone(update);
  return runtime.enqueueProfileOperation(profileId, async () => {
    const instance = runtime.instances.get(String(profileId));
    if (!instance) return { ok: true, data: { found: false, changed: false, restarted: false, state: null } };
    const changes = typeof captured === 'function'
      ? captured({ lowSpecSystem: structuredClone(instance.profile.lowSpecSystem) })
      : captured;
    const changed = Object.keys(changes).some((key) => !isDeepStrictEqual(instance.profile[key], changes[key]));
    Object.assign(instance.profile, structuredClone(changes));
    instance.configurationPending ||= changed;
    const restart = options.restart === true
      && (options.onlyIfChanged !== true || instance.configurationPending);
    const state = restart ? await runtime.restartNow(profileId) : runtime.getState(profileId);
    if (restart) {
      const active = runtime.instances.get(String(profileId));
      if (active) active.configurationPending = false;
    }
    return { ok: true, data: { found: true, changed, restarted: restart, state } };
  });
}

module.exports = { updateProfileConfiguration };

'use strict';

const { canTransition, createRuntimeState, normalizeBounds } = require('./runtime-types');

function stateId(value) {
  const id = String(value || '').trim();
  if (!id || id === '.' || id === '..') throw new Error('无效的 Profile ID');
  return id;
}

/** @template {{lastError?: any}} T @param {T} state @returns {T} */
function cloneRuntimeState(state) {
  const lastError = state.lastError instanceof Error
    ? { ...state.lastError, name: state.lastError.name, message: state.lastError.message }
    : state.lastError;
  return structuredClone({ ...state, ...(lastError ? { lastError } : {}) });
}

// In-memory lifecycle only. Disk paths, migrations and locks belong to ProfileRuntimeStore.
class RuntimeStateStore {
  /** @param {(state: ReturnType<typeof createRuntimeState>) => void} [onStateChanged] */
  constructor(onStateChanged = () => {}) {
    this.states = new Map();
    this.onStateChanged = onStateChanged;
  }

  createState(profileId, runtimeType, patch = {}) {
    const businessProfileId = stateId(profileId);
    const id = businessProfileId;
    const state = createRuntimeState(businessProfileId, runtimeType, patch);
    this.states.set(id, state);
    this.onStateChanged(cloneRuntimeState(state));
    return this.getState(businessProfileId);
  }

  getState(profileId) {
    const state = this.states.get(stateId(profileId));
    return state ? cloneRuntimeState(state) : null;
  }

  patchState(profileId, patch = {}) {
    const id = stateId(profileId);
    const current = this.states.get(id);
    if (!current) throw new Error(`Profile ${id} 没有运行状态`);
    if (patch.status !== undefined && !canTransition(current.status, patch.status)) {
      throw new Error(`非法运行时状态迁移: ${current.status} -> ${patch.status}`);
    }
    const next = { ...current, ...patch };
    if (patch.bounds) next.bounds = normalizeBounds(patch.bounds);
    this.states.set(id, next);
    this.onStateChanged(cloneRuntimeState(next));
    return cloneRuntimeState(next);
  }

  transition(profileId, status, patch = {}) {
    return this.patchState(profileId, { ...patch, status });
  }

  listStates() {
    return Array.from(this.states.values()).map(cloneRuntimeState);
  }

  clearState(profileId) {
    return this.states.delete(stateId(profileId));
  }

}

module.exports = { RuntimeStateStore, cloneRuntimeState };

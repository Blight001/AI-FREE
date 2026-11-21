'use strict';

function softDelete(state, entry) {
  entry.deletedAt = Date.now();
  entry.updatedAt = entry.deletedAt;
  if (state.selectedId === entry.id) {
    state.selectedId = state.items.find((item) => !item.deletedAt)?.id || '';
  }
  return entry.deletedAt;
}

function restore(entry) {
  if (!entry.deletedAt) throw new Error('Automation is not in the recycle bin');
  entry.deletedAt = null;
  entry.updatedAt = Date.now();
}

function purge(state, entry) {
  if (!entry.deletedAt) throw new Error('Only trashed automations can be permanently deleted');
  state.items = state.items.filter((item) => item !== entry);
}

function assertEditable(entry) {
  if (entry?.deletedAt) throw new Error('Restore the automation before editing it');
}

module.exports = { assertEditable, purge, restore, softDelete };

'use strict';

(() => {
  const get = (id) => document.getElementById(id);
  const { target, mode } = get('upload-fixture').dataset;
  const input = get('fixture-file');
  const submit = get('fixture-submit');
  const read = get('fixture-read');
  let selected = null;

  function display(state) {
    get('selection-count').textContent = state.selectionCount;
    get('received-count').textContent = state.receivedCount;
    get('received-name').textContent = state.lastReceived?.name ?? '-';
    get('received-sha256').textContent = state.lastReceived?.sha256 ?? '-';
    get('dropped-receipts').textContent = state.droppedReceipts;
  }

  async function send(action, file) {
    const response = await fetch(`/${target}/${action}?mode=${mode}`, {
      method: 'POST', headers: { 'X-Fixture-Filename': encodeURIComponent(file.name) }, body: file,
    });
    if (!response.ok) throw new Error(`fixture status ${response.status}`);
    display(await response.json());
  }

  async function lockControls(operation) {
    input.disabled = submit.disabled = read.disabled = true;
    try { await operation(); }
    finally {
      input.disabled = read.disabled = false;
      submit.disabled = !selected;
    }
  }

  input.addEventListener('change', () => lockControls(async () => {
    selected = null;
    get('receipt-status').textContent = 'idle';
    const file = input.files[0];
    get('selection-status').textContent = file ? 'pending' : 'empty';
    if (!file) return;
    try {
      await send('select', file);
      selected = file;
      get('selection-status').textContent = 'selected';
    } catch {
      get('selection-status').textContent = 'selection-error';
    }
  }));

  submit.addEventListener('click', () => lockControls(async () => {
    if (!selected) return;
    get('receipt-status').textContent = 'pending';
    try {
      await send('submit', selected);
      get('receipt-status').textContent = 'confirmed';
    } catch {
      get('receipt-status').textContent = 'unknown';
    }
  }));

  function readback() {
    return lockControls(async () => {
      get('readback-status').textContent = 'pending';
      try {
        const response = await fetch('/state');
        if (!response.ok) throw new Error(`fixture status ${response.status}`);
        display((await response.json())[target]);
        get('readback-status').textContent = 'verified';
      } catch {
        get('readback-status').textContent = 'readback-error';
      }
    });
  }

  read.addEventListener('click', readback);
  void readback();
})();

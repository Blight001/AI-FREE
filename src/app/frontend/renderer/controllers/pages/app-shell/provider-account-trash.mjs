function trashAction(label, activate) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'browser-default-settings-btn';
  button.textContent = label;
  button.addEventListener('click', activate);
  return button;
}

export function bindProviderTrash(root, refreshAccounts, hidePassword) {
  const dialog = document.getElementById('provider-trash-dialog');
  const status = dialog.querySelector('#provider-trash-status');
  const list = dialog.querySelector('#provider-trash-list');
  const api = window.aiFree.account;
  let request;
  let busy = false;

  function close() {
    homeDialogs.close(dialog);
  }

  async function refresh() {
    if (!dialog.open) return;
    const current = request = {};
    status.textContent = '正在读取回收站…';
    try {
      const result = await api.listProviderAccountTrash();
      if (current !== request || !dialog.open) return;
      if (!result?.ok) throw new Error(result?.error?.message || '读取失败');
      const { accounts } = result.data;
      list.replaceChildren(...accounts.map(createRow));
      status.textContent = accounts.length ? '' : '回收站为空';
    } catch (error) {
      if (current === request && dialog.open) status.textContent = error.message;
    }
  }

  async function act(account, purge) {
    if (busy) return;
    busy = true;
    try {
      if (purge && !await homeDialogs.confirm(`彻底删除 ${account.email}？删除后无法恢复。`)) return;
      const invoke = purge ? api.purgeProviderAccount : api.restoreProviderAccount;
      const result = await invoke({ id: account.id });
      if (!result?.ok) throw new Error(result?.error?.message || '操作失败');
      await refresh();
      if (!purge) await refreshAccounts();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
    }
  }

  function createRow(account) {
    const row = document.createElement('div');
    row.className = 'provider-account-row';
    const info = document.createElement('div');
    info.className = 'provider-account-info';
    const name = document.createElement('strong');
    name.textContent = account.email;
    const deleted = document.createElement('small');
    deleted.textContent = `${account.category} · ${new Date(account.deletedAt).toLocaleString()}`;
    info.append(name, deleted);
    const buttons = document.createElement('div');
    buttons.className = 'provider-account-row-actions';
    buttons.append(trashAction('恢复', () => void act(account, false)), trashAction('彻底删除', () => void act(account, true)));
    row.append(info, buttons);
    return row;
  }

  root.addEventListener('click', (event) => {
    if (!event.target.closest('.provider-trash-open')) return;
    hidePassword();
    if (homeDialogs.open(dialog, { onClose: () => list.replaceChildren() })) void refresh();
  });
  dialog.querySelector('#provider-trash-close').addEventListener('click', close);
  return { refresh };
}

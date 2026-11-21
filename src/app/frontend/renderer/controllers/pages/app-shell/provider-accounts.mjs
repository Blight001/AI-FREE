import { ProviderAccountDialog } from './provider-account-dialog.mjs';
import { createProviderPasswordControl } from './provider-account-password.mjs';
import { bindProviderCategoryTabs } from './provider-category-tabs.mjs';

function rowButton(label, className, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

function renderAccounts(list, accounts, makeRow) {
  if (accounts.length) {
    list.replaceChildren(...accounts.map(makeRow));
  } else {
    const empty = document.createElement('div');
    empty.className = 'shell-home-record-empty';
    empty.textContent = '暂无账号';
    list.replaceChildren(empty);
  }
}

function bindProviderAccounts(root) {
  const passwords = createProviderPasswordControl(root);
  const dialog = new ProviderAccountDialog({
    dialog: document.getElementById('provider-account-dialog'), refresh: loadAccounts, hidePassword: passwords.hide,
  });

  async function deleteAccount(panel, account, button) {
    if (!await homeDialogs.confirm(`删除账号 ${account.email}？`)) return;
    passwords.hide();
    button.disabled = true;
    try {
      const result = await window.aiFree.account.deleteProviderAccount({ provider: panel.dataset.provider, id: account.id });
      if (!result?.ok) throw new Error(result?.error?.message || '删除失败');
      await loadAccounts(panel);
    } catch (error) {
      window.MessageModal?.showErrorMessage?.(error.message);
      button.disabled = false;
    }
  }

  function makeRow(panel, account) {
    const row = document.createElement('div');
    row.className = 'provider-account-row';
    const info = document.createElement('div');
    info.className = 'provider-account-info';
    const credentials = document.createElement('div');
    credentials.className = 'provider-account-credentials';
    const email = document.createElement('strong');
    email.textContent = account.email;
    credentials.append(email, passwords.create({ provider: panel.dataset.provider, id: account.id }));
    info.append(credentials);
    if (account.note) {
      const note = document.createElement('small');
      note.textContent = `备注：${account.note}`;
      info.append(note);
    }
    const actions = document.createElement('div');
    actions.className = 'provider-account-row-actions';
    const edit = rowButton(account.note ? '编辑备注' : '添加备注', 'provider-edit-note', () => dialog.open(panel, {}, account));
    edit.setAttribute('aria-haspopup', 'dialog');
    const remove = rowButton('删除', 'provider-remove-account', () => void deleteAccount(panel, account, remove));
    actions.append(edit, remove);
    row.append(info, actions);
    return row;
  }

  const loads = new WeakMap();
  async function loadAccounts(panel) {
    if (!panel.isConnected) return;
    passwords.hide();
    const request = {};
    loads.set(panel, request);
    const list = panel.querySelector('.provider-account-list');
    list.textContent = '正在读取账号…';
    try {
      const result = await window.aiFree.account.listProviderAccounts({ provider: panel.dataset.provider });
      if (loads.get(panel) !== request) return;
      if (!result?.ok) throw new Error(result?.error?.message || '读取失败');
      renderAccounts(list, result.accounts || [], (account) => makeRow(panel, account));
    } catch (error) {
      if (loads.get(panel) === request) list.textContent = `读取失败：${error.message}`;
    }
  }

  bindProviderCategoryTabs(root, {
    activate: (panel) => { dialog.close(); void loadAccounts(panel); },
    openAccount: (panel, category) => dialog.open(panel, category),
    hidePassword: passwords.hide,
  });
}

const root = document.getElementById('home-accounts');
if (root) bindProviderAccounts(root);

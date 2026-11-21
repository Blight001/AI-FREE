import { ProviderAccountDialog } from './provider-account-dialog.mjs';
import { createProviderPasswordControl } from './provider-account-password.mjs';
import { bindProviderTrash } from './provider-account-trash.mjs';
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

function makeRow(panel, category, account, { passwords, dialog, deleteAccount }) {
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
  const replace = rowButton('更换凭据', 'browser-default-settings-btn', () => dialog.open(panel, category, account, true));
  actions.append(edit, replace, remove);
  row.append(info, actions);
  return row;
}

function bindProviderAccounts(root) {
  const passwords = createProviderPasswordControl(root);
  const panelCategories = new WeakMap();
  const dialog = new ProviderAccountDialog({
    dialog: document.getElementById('provider-account-dialog'), refresh: (panel) => loadAccounts(panel, panelCategories.get(panel)), hidePassword: passwords.hide,
  });

  async function deleteAccount(panel, account, button) {
    if (!await homeDialogs.confirm(`将账号 ${account.email} 移入回收站？`)) return;
    passwords.hide();
    button.disabled = true;
    try {
      const result = await window.aiFree.account.deleteProviderAccount({ provider: panel.dataset.provider, id: account.id });
      if (!result?.ok) throw new Error(result?.error?.message || '删除失败');
      await loadAccounts(panel, panelCategories.get(panel));
    } catch (error) {
      window.MessageModal?.showErrorMessage?.(error.message);
      button.disabled = false;
    }
  }


  const loads = new WeakMap();
  async function loadAccounts(panel, category) {
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
      renderAccounts(list, result.accounts || [], (account) => makeRow(panel, category, account, { passwords, dialog, deleteAccount }));
    } catch (error) {
      if (loads.get(panel) === request) list.textContent = `读取失败：${error.message}`;
    }
  }

  const tabs = bindProviderCategoryTabs(root, {
    activate: (panel, category) => {
      panelCategories.set(panel, category);
      dialog.close();
      void loadAccounts(panel, category);
    },
    openAccount: (panel, category) => dialog.open(panel, category),
    hidePassword: passwords.hide,
  });
  const trash = bindProviderTrash(root, () => tabs.load(), passwords.hide);
  bindMcpAccountUpdates(root, dialog, tabs, trash);
}

function bindMcpAccountUpdates(root, dialog, tabs, trash) {
  const readChange = window.aiFree.account.onProviderAccountsChanged(() => {
    if (!dialog.dialog.open) void tabs.load();
    trash.refresh();
  });
  const readEditor = window.aiFree.account.onProviderAccountEditor(async ({ provider, id }) => {
    if (dialog.busy || dialog.dialog.open) return;
    document.getElementById('home-accounts-tab').click();
    const entry = await tabs.load(provider);
    if (entry?.category.id !== provider || root.closest('[hidden]')) return;
    if (!id) dialog.open(entry.panel, entry.category);
    else {
      const result = await window.aiFree.account.listProviderAccounts({ provider });
      const account = result?.accounts?.find((item) => item.id === id);
      if (account && !root.closest('[hidden]') && !entry.panel.hidden) dialog.open(entry.panel, entry.category, account, true);
    }
  });
  window.addEventListener('pagehide', () => { readChange(); readEditor(); }, { once: true });
}

const root = document.getElementById('home-accounts');
if (root) bindProviderAccounts(root);

import { ProviderCategoryActions } from './provider-category-actions.mjs';

export function bindProviderCategoryTabs(root, { activate, openAccount, hidePassword }) {
  const tabList = root.querySelector('.provider-account-tabs');
  const panels = root.querySelector('#provider-account-panels');
  const template = root.querySelector('#provider-account-panel');
  const add = root.querySelector('#provider-category-add');
  const retry = root.querySelector('#provider-catalog-retry');
  const status = root.querySelector('#provider-catalog-status');
  const entries = new Map();
  const actions = new ProviderCategoryActions(root, applyChange, hidePassword);
  let selected;

  function select(entry, focus = false) {
    selected = entry;
    actions.closeMenu();
    entries.forEach(({ tab, panel }, id) => {
      const active = id === entry.category.id;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      panel.hidden = !active;
    });
    if (focus && !root.closest('[hidden]')) entry.tab.focus();
    activate(entry.panel);
  }

  function addEntry(category) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.id = `provider-${category.id}-tab`;
    tab.setAttribute('role', 'tab');
    const panel = template.content.firstElementChild.cloneNode(true);
    panel.id = `provider-${category.id}-panel`;
    panel.dataset.provider = category.id;
    panel.setAttribute('aria-labelledby', tab.id);
    tab.setAttribute('aria-controls', panel.id);
    const entry = { tab, panel, category };
    updateName(entry, category);
    entries.set(category.id, entry);
    tab.addEventListener('click', () => select(entry));
    panel.querySelector('.provider-add-account').addEventListener('click', () => openAccount(panel, entry.category));
    if (category.custom) {
      tab.addEventListener('contextmenu', (event) => actions.showMenu(event, entry));
    }
    tabList.insertBefore(tab, add);
    panels.append(panel);
    return entry;
  }

  function applyChange(action, entry, category) {
    if (action === 'create') select(addEntry(category), true);
    else if (action === 'rename') {
      updateName(entry, category);
      if (!root.closest('[hidden]')) entry.tab.focus();
    } else {
      entries.delete(entry.category.id);
      entry.tab.remove();
      entry.panel.remove();
      if (selected === entry) select(entries.values().next().value, true);
      else if (!root.closest('[hidden]')) selected.tab.focus();
    }
  }

  async function load() {
    retry.hidden = true;
    status.textContent = '正在读取账号栏目…';
    try {
      const result = await window.aiFree.account.listProviderCategories();
      if (!result?.ok) throw new Error(result?.error?.message || '读取账号栏目失败');
      const categories = result.data.categories;
      for (const category of categories) addEntry(category);
      select(entries.values().next().value);
      status.textContent = '';
      add.disabled = false;
    } catch (error) {
      status.textContent = error.message;
      retry.hidden = false;
    }
  }

  add.addEventListener('click', () => actions.open('create'));
  retry.addEventListener('click', () => void load());
  tabList.addEventListener('keydown', (event) => navigateTabs(event, [...entries.values()], select));
  void load();
}

function updateName(entry, category) {
  entry.category = category;
  entry.tab.textContent = category.name;
  entry.panel.querySelector('h2').textContent = `${category.name} 账号`;
}

function navigateTabs(event, entries, select) {
  const index = entries.findIndex((entry) => event.target === entry.tab);
  if (index < 0) return;
  const count = entries.length;
  const keys = new Map([['ArrowLeft', (index + count - 1) % count], ['ArrowRight', (index + 1) % count], ['Home', 0], ['End', count - 1]]);
  const position = keys.get(event.key);
  if (position === undefined) return;
  event.preventDefault();
  select(entries[position], true);
}

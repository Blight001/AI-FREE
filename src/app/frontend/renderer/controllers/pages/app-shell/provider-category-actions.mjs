export class ProviderCategoryActions {
  constructor(root, onChange, hidePassword) {
    this.menu = root.querySelector('#provider-category-menu');
    this.dialog = document.getElementById('provider-category-dialog');
    this.form = this.dialog.querySelector('form');
    this.title = this.form.querySelector('h2');
    this.name = this.form.elements.namedItem('name');
    this.warning = this.form.querySelector('.provider-category-warning');
    this.status = this.form.querySelector('[role="status"]');
    this.save = this.form.querySelector('[type="submit"]');
    this.cancel = this.form.querySelector('[type="button"]');
    this.onChange = onChange;
    this.hidePassword = hidePassword;
    this.menu.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (!action || !this.target) return;
      const entry = this.target;
      this.closeMenu();
      this.open(action, entry);
    });
    this.cancel.addEventListener('click', () => homeDialogs.close(this.dialog));
    this.dialog.addEventListener('cancel', (event) => { if (this.save.disabled) event.preventDefault(); });
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submit();
    });
  }

  closeMenu() {
    this.menu.hidePopover();
    this.target = null;
  }

  showMenu(event, entry) {
    event.preventDefault();
    this.closeMenu();
    this.hidePassword();
    this.target = entry;
    this.menu.showPopover();
    const anchor = entry.tab.getBoundingClientRect();
    const homeRight = entry.tab.closest('#browser-empty-state').getBoundingClientRect().right;
    const left = event.clientX || anchor.left;
    const top = event.clientY || anchor.bottom;
    this.menu.style.left = `${Math.max(4, Math.min(left, homeRight - this.menu.offsetWidth - 4))}px`;
    this.menu.style.top = `${Math.max(4, Math.min(top, innerHeight - this.menu.offsetHeight - 4))}px`;
    this.menu.querySelector('button').focus();
  }

  open(action, entry = null) {
    if (this.save.disabled || this.dialog.open) return;
    this.hidePassword();
    this.action = action;
    this.entry = entry;
    const removing = action === 'remove';
    this.title.textContent = { create: '新增账号栏目', rename: '重命名栏目', remove: '删除账号栏目' }[action];
    this.name.value = removing ? '' : entry?.category.name || '';
    this.name.disabled = this.name.closest('label').hidden = removing;
    this.warning.hidden = !removing;
    this.warning.textContent = removing ? `确定删除「${entry.category.name}」？此栏目中的所有账号将移入账号回收站，可按账号恢复。` : '';
    this.save.textContent = removing ? '确认删除' : '保存';
    this.status.textContent = '';
    if (!homeDialogs.open(this.dialog, { resolveFocus: () => entry?.tab })) return;
    if (removing) this.cancel.focus();
    else this.name.select();
  }

  async change(action, provider, name) {
    const api = window.aiFree.account;
    if (action === 'create') return api.createProviderCategory({ name });
    if (action === 'rename') return api.renameProviderCategory({ provider, name });
    return api.deleteProviderCategory({ provider });
  }

  async submit() {
    if (this.save.disabled || !this.dialog.open) return;
    const { action, entry } = this;
    this.save.disabled = this.cancel.disabled = true;
    this.status.textContent = '';
    try {
      const result = await this.change(action, entry?.category.id, this.name.value);
      if (!result?.ok) throw new Error(result?.error?.message || '操作失败，请重试');
      homeDialogs.close(this.dialog);
      this.onChange(action, entry, result.data.category);
    } catch (error) {
      if (this.dialog.open) this.status.textContent = error.message;
    } finally {
      this.save.disabled = this.cancel.disabled = false;
    }
  }
}

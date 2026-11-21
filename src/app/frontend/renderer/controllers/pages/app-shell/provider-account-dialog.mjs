import { ProviderAccountImportDialog } from './provider-account-import.mjs';

export class ProviderAccountDialog {
  constructor({ dialog, refresh, hidePassword }) {
    this.dialog = dialog;
    this.refresh = refresh;
    this.hidePassword = hidePassword;
    this.form = dialog.querySelector('form');
    this.title = dialog.querySelector('h2');
    this.fields = this.form.querySelector('fieldset');
    this.credentials = [...this.fields.querySelectorAll('[data-credential]')];
    this.login = this.form.elements.namedItem('email');
    this.loginLabel = this.form.querySelector('.provider-login-label');
    this.note = this.form.elements.namedItem('note');
    this.email = this.form.querySelector('.provider-account-edit-email');
    this.submit = this.form.querySelector('[type="submit"]');
    this.cancel = this.form.querySelector('.provider-cancel');
    this.status = this.form.querySelector('#provider-account-save-status');
    this.importSection = this.form.querySelector('#provider-account-import');
    this.importer = new ProviderAccountImportDialog({
      section: this.importSection,
      closeButton: this.cancel,
      refresh,
      isOpen: () => dialog.open,
      onPreviewChange: (preview) => this.setPreview(preview),
    });
    this.cancel.addEventListener('click', () => this.close());
    dialog.addEventListener('cancel', (event) => { if (this.busy) event.preventDefault(); });
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.save();
    });
  }

  get busy() { return this.submit.disabled || this.importer.busy; }

  setPreview(preview) {
    this.fields.hidden = this.fields.disabled = this.submit.hidden = preview;
    if (preview) this.setStatus('');
  }

  setStatus(message, isError = false) {
    this.status.textContent = message;
    this.status.dataset.error = String(isError);
  }

  clear() {
    this.form.reset();
    this.importer.reset();
    this.account = null;
    this.email.textContent = '';
    this.setStatus('');
  }

  close() {
    if (!this.dialog.open) return;
    homeDialogs.close(this.dialog);
  }

  open(panel, { name, custom }, account = null) {
    if (this.busy || this.dialog.open) return;
    this.clear();
    this.hidePassword();
    this.account = account;
    this.panel = panel;
    const editing = !!account;
    this.title.textContent = editing ? '编辑备注' : `添加 ${name} 账号`;
    this.email.hidden = !editing;
    this.importSection.hidden = editing;
    this.email.textContent = account?.email || '';
    this.note.value = account?.note || '';
    this.login.type = custom ? 'text' : 'email';
    this.loginLabel.textContent = custom ? '账号' : '邮箱';
    for (const label of this.credentials) label.hidden = label.querySelector('input').disabled = editing;
    this.submit.textContent = editing ? '保存备注' : '保存账号';
    this.importer.open(panel, custom);
    homeDialogs.open(this.dialog, { focus: editing ? this.note : undefined, onClose: () => this.clear() });
  }

  async save() {
    if (this.busy || !this.dialog.open || this.submit.hidden) return;
    const { account, panel } = this;
    const input = { provider: panel.dataset.provider, note: this.note.value };
    const fields = new FormData(this.form);
    const api = window.aiFree.account;
    this.submit.disabled = this.cancel.disabled = this.importer.previewButton.disabled = true;
    this.setStatus('正在保存…');
    try {
      const result = account
        ? await api.updateProviderAccountNote({ ...input, id: account.id })
        : await api.saveProviderAccount({ ...input, email: fields.get('email'), password: fields.get('password') });
      if (!result?.ok) throw new Error(result?.error?.message || '保存失败');
      this.close();
      await this.refresh(panel);
    } catch (error) {
      if (this.dialog.open) this.setStatus(error.message, true);
    } finally {
      this.submit.disabled = this.cancel.disabled = this.importer.previewButton.disabled = false;
    }
  }
}

import { MAX_IMPORT_ACCOUNTS, parseProviderAccountText } from './provider-account-import-parser.mjs';

function makeButton(label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

function makeRow(email, detail = '') {
  const row = document.createElement('li');
  row.className = 'provider-account-row';
  const info = document.createElement('span');
  info.className = 'provider-account-info';
  info.textContent = email;
  if (detail) {
    const status = document.createElement('small');
    status.textContent = detail;
    info.append(status);
  }
  row.append(info);
  return row;
}

export class ProviderAccountImportDialog {
  constructor({ section, closeButton, refresh, isOpen, onPreviewChange }) {
    this.refresh = refresh;
    this.isOpen = isOpen;
    this.onPreviewChange = onPreviewChange;
    this.editor = section.querySelector('textarea');
    this.input = section.querySelector('.provider-import-input');
    this.rows = section.querySelector('ol');
    this.status = section.querySelector('[role="status"]');
    this.previewButton = section.querySelector('.provider-import-preview');
    this.confirmButton = section.querySelector('.provider-import-confirm');
    this.resetButton = section.querySelector('.provider-import-reset');
    this.closeButton = closeButton;
    this.previewButton.addEventListener('click', () => this.preview());
    this.confirmButton.addEventListener('click', () => void this.commit());
    this.resetButton.addEventListener('click', () => {
      this.reset();
      this.editor.focus();
    });
    this.busy = false;
    this.reset();
  }

  reset() {
    this.draft = [];
    this.skipped = 0;
    this.editor.value = '';
    this.rows.replaceChildren();
    this.status.textContent = '';
    this.input.hidden = false;
    this.previewButton.hidden = false;
    this.confirmButton.hidden = true;
    this.resetButton.hidden = true;
    this.closeButton.textContent = '取消';
    this.onPreviewChange(false);
  }

  open(panel, custom) {
    this.panel = panel;
    this.custom = custom;
  }

  preview() {
    try {
      const { accounts, skipped } = parseProviderAccountText(this.editor.value, this.custom);
      this.draft = accounts;
      this.skipped = skipped;
    } catch {
      this.status.textContent = `文本过长，或账号超过 ${MAX_IMPORT_ACCOUNTS} 个，请分批导入。`;
      return;
    }
    if (!this.draft.length) {
      this.status.textContent = '没有识别到可导入的账号。';
      return;
    }
    this.editor.value = '';
    this.input.hidden = true;
    this.previewButton.hidden = true;
    this.confirmButton.hidden = false;
    this.resetButton.hidden = false;
    this.onPreviewChange(true);
    this.renderPreview();
    this.confirmButton.focus();
  }

  renderPreview() {
    const rows = this.draft.map((entry) => {
      const row = makeRow(entry.email);
      const remove = makeButton('移除', () => {
        this.draft = this.draft.filter((account) => account !== entry);
        this.renderPreview();
        (this.rows.querySelector('button') || this.resetButton).focus();
      });
      remove.setAttribute('aria-label', `移除 ${entry.email}`);
      row.append(remove);
      return row;
    });
    this.rows.replaceChildren(...rows);
    this.confirmButton.disabled = !rows.length;
    this.status.textContent = `待导入 ${rows.length} 个，已跳过 ${this.skipped} 条。`;
  }

  setBusy(busy) {
    this.busy = busy;
    this.closeButton.disabled = this.confirmButton.disabled = this.resetButton.disabled = busy;
  }

  async commit() {
    if (!this.draft.length || this.busy) return;
    const panel = this.panel;
    this.setBusy(true);
    this.rows.replaceChildren();
    this.status.textContent = '正在加密导入…';
    const draft = this.draft;
    this.draft = [];
    const results = [];
    try {
      for (const account of draft) {
        if (!this.isOpen()) break;
        results.push(await this.save(panel.dataset.provider, account));
      }
      if (this.isOpen()) this.renderResults(panel, results);
      await this.refresh(panel);
    } finally {
      draft.length = 0;
      this.setBusy(false);
      if (this.isOpen()) this.closeButton.focus();
    }
  }

  async save(provider, { email, password }) {
    try {
      const result = await window.aiFree.account.saveProviderAccount({ provider, email, password });
      if (result?.ok && result.account?.id) return { email, id: result.account.id };
      if (result?.error?.message === 'Account already exists') return { email, detail: '已存在，未覆盖' };
    } catch {
      // A single failed save must not hide which other accounts were imported.
    }
    return { email, detail: '未导入' };
  }

  renderResults(panel, results) {
    this.confirmButton.hidden = true;
    this.closeButton.textContent = '完成';
    const imported = results.filter(({ id }) => id).length;
    this.status.textContent = `已导入 ${imported} 个，未导入 ${results.length - imported} 个。`;
    this.rows.replaceChildren(...results.map(({ id, email, detail }) => {
      const row = makeRow(email, id ? '已导入' : detail);
      if (id) this.bindDelete(row, panel, { id, email });
      return row;
    }));
  }

  bindDelete(row, panel, { id, email }) {
    const remove = makeButton('删除', () => {
      remove.hidden = true;
      confirm.hidden = cancel.hidden = false;
      confirm.focus();
    });
    const cancel = makeButton('取消', () => {
      confirm.hidden = cancel.hidden = true;
      remove.hidden = false;
      remove.focus();
    });
    const confirm = makeButton('确认删除', async () => {
      confirm.disabled = cancel.disabled = true;
      try {
        const result = await window.aiFree.account.deleteProviderAccount({ provider: panel.dataset.provider, id });
        if (!result?.ok) throw new Error();
        if (row.isConnected) {
          row.replaceWith(makeRow(email, '已删除'));
          this.closeButton.focus();
        }
        await this.refresh(panel);
      } catch {
        if (row.isConnected) row.querySelector('small').textContent = '删除失败，请重试。';
        confirm.disabled = cancel.disabled = false;
      }
    });
    remove.setAttribute('aria-label', `删除 ${email}`);
    confirm.setAttribute('aria-label', `确认删除 ${email}`);
    confirm.hidden = cancel.hidden = true;
    row.append(remove, confirm, cancel);
  }
}

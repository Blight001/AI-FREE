'use strict';

class SitePreferenceTransfer {
  constructor(panel) {
    this.panel = panel;
    this.sequence = 0;
  }

  get(name) { return this.panel.get(name); }

  reset() {
    this.sequence++;
    this.revision = '';
    this.get('transfer').hidden = true;
    this.get('apply').disabled = true;
    this.setCopying(false);
  }

  ticket() {
    return { format: 'ai-free.site-preferences.v1', sourceId: this.panel.historyId, host: this.panel.selected.host };
  }

  open(ticket, destination) {
    if (ticket?.format !== 'ai-free.site-preferences.v1' || typeof ticket.sourceId !== 'string' || typeof ticket.host !== 'string') {
      throw new Error('请粘贴从来源浏览器复制的站点偏好引用');
    }
    this.openPreview(ticket, destination);
  }

  openPreview(source, destination) {
    this.reset();
    this.source = source;
    this.get('apply').textContent = source.indexedDb ? '复制全部 IndexedDB' : '应用偏好';
    this.get('transfer-scope').textContent = source.indexedDb
      ? '请关闭两边的浏览器。复制所选域名的全部第一方默认 IndexedDB，两个浏览器和目标浏览器的其他网站数据都会保留。'
      : '应用范围为所选网站的偏好，两个浏览器和目标浏览器的其他网站数据都会保留。';
    const rows = [...document.querySelectorAll('#browser-history-list [data-history-id]')];
    const options = rows.filter((row) => row.dataset.historyId !== source.sourceId).map((row) =>
      new Option(row.querySelector('.browser-history-name').textContent, row.dataset.historyId));
    const select = this.get('target');
    select.replaceChildren(...options);
    if (destination) select.value = destination;
    this.get('transfer').hidden = false;
    select.focus();
    void this.run(false);
  }

  setCopying(copying) {
    this.get('target').disabled = copying;
    this.get('cancel').disabled = copying;
  }

  async run(apply) {
    const sequence = ++this.sequence;
    const target = this.get('target');
    const targetId = target.value;
    const targetName = target.selectedOptions[0]?.textContent;
    const revision = this.revision;
    this.get('apply').disabled = true;
    this.revision = '';
    const preview = this.get('preview');
    if (!targetId) { preview.textContent = '请选择与来源不同的浏览器'; return; }
    preview.textContent = apply ? '正在复制…' : '正在准备预览…';
    this.setCopying(apply);
    const { sourceId, host, indexedDb } = this.source;
    const payload = { sourceId, targetId, host, ...(apply ? { revision } : {}) };
    try {
      const { browser } = window.aiFree;
      const result = indexedDb
        ? await browser.transferSiteIndexedDb(payload)
        : await browser.transferSitePreferences(payload);
      if (sequence !== this.sequence) return;
      if (!result.ok) throw new Error(result.error?.message || '操作失败，请重新预览');
      if (apply) {
        const message = indexedDb
          ? `已将 ${host} 的 ${result.data.origins.length} 个 IndexedDB 来源地址复制到「${targetName}」`
          : `已核对「${targetName}」中 ${host} 的 ${result.data.verifiedCount} 条站点偏好`;
        await this.showResult(targetId, message);
      } else {
        this.renderPreview(result.data, { host, indexedDb, targetName });
      }
    } catch (error) {
      if (sequence === this.sequence) preview.textContent = error.message;
    } finally {
      if (sequence === this.sequence) this.setCopying(false);
    }
  }

  renderPreview(data, { host, indexedDb, targetName }) {
    const { changes } = data;
    const size = new Intl.NumberFormat('zh-CN', { style: 'unit', unit: 'kilobyte', maximumFractionDigits: 1 });
    this.get('preview').textContent = indexedDb
      ? `复制 ${data.origins.length} 个来源地址的 IndexedDB（${size.format(data.bytes / 1000)}）到「${targetName}」${['', ...data.origins].join('\n')}`
      : changes.length ? changes.map(describeSiteRuleChange).join('\n') : `${host} 的设置已经一致`;
    this.revision = data.revision;
    this.get('apply').disabled = !indexedDb && !changes.length;
  }

  async showResult(targetId, message) {
    this.reset();
    if (targetId === this.panel.historyId) await this.panel.refresh();
    if (this.panel.dialog.open) this.get('notice').textContent = message;
  }

  bind() {
    this.get('target').addEventListener('change', () => this.run(false));
    this.get('migrate-db').addEventListener('click', () => this.openPreview({
      sourceId: this.panel.historyId, host: this.panel.selected.host, indexedDb: true,
    }));
    this.get('cancel').addEventListener('click', () => this.reset());
    this.get('apply').addEventListener('click', () => this.run(true));
    this.get('migrate').addEventListener('click', () => this.open(this.ticket()));
    this.get('copy-ticket').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(this.ticket(), null, 2));
        this.get('notice').textContent = '已复制偏好引用，导入时需要保留来源浏览器记录';
      } catch { this.get('notice').textContent = '剪贴板写入失败'; }
    });
    this.get('paste').addEventListener('click', async () => {
      const generation = this.panel.generation;
      try {
        const text = await navigator.clipboard.readText();
        if (generation !== this.panel.generation) return;
        if (text.length > 2048) throw new Error('迁移 JSON 过长');
        this.open(JSON.parse(text), this.panel.historyId);
      } catch { this.get('notice').textContent = '请先从来源浏览器复制偏好引用，并允许读取剪贴板'; }
    });
  }
}

function describeSiteRuleChange({ pattern, kind, before, after }) {
  const labels = { 1: '允许', 2: '阻止' };
  return `${pattern.split(',')[0]} · ${kind === 'images' ? '图片' : '声音'}：${labels[before] || '默认'} → ${labels[after]}`;
}

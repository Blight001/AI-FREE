'use strict';

class SiteDataPanel {
  constructor() {
    this.dialog = this.get('dialog');
    this.search = this.get('search');
    this.generation = 0;
    this.sites = [];
    this.transfer = new SitePreferenceTransfer(this);
  }

  get(name) { return document.getElementById(`site-data-${name}`); }

  details(site) {
    this.transfer.reset();
    this.selected = site;
    const portable = Boolean(site?.rules?.length);
    const hint = this.get('pref-state');
    hint.hidden = !site || portable;
    hint.textContent = this.preferencesUnavailable ? '图片和声音偏好暂时无法读取' : '该域名没有单独设置图片或声音偏好';
    this.get('copy-ticket').disabled = !portable;
    this.get('migrate').disabled = !portable;
    this.get('host').textContent = site?.host || '网站详情';
    this.get('copy').disabled = !site;
    this.renderCounts(site);
  }

  renderCounts(site) {
    this.get('migrate-db').disabled = !site?.indexedDbOrigins?.length;
    const counts = this.get('counts');
    counts.replaceChildren();
    if (!site) return;
    for (const [label, value] of [['Cookie 记录', site.cookies], ['存储桶', site.buckets], ['IndexedDB 来源地址', site.indexedDbOrigins?.length || 0]]) {
      const term = document.createElement('dt');
      const count = document.createElement('dd');
      term.textContent = label;
      count.textContent = value ?? '未读取';
      counts.append(term, count);
    }
    for (const rule of site.rules || []) {
      const term = document.createElement('dt');
      const value = document.createElement('dd');
      term.textContent = `${rule.kind === 'sound' ? '声音' : '图片'} · ${rule.pattern.split(',')[0]}`;
      value.textContent = rule.setting === 1 ? '允许' : '阻止';
      counts.append(term, value);
    }
  }

  render() {
    const query = this.search.value.trim().toLowerCase();
    const matches = this.sites.filter((site) => site.host.includes(query));
    this.details(matches.find((site) => site.host === this.selected?.host) || matches[0]);
    const buttons = matches.map((site) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = site.host;
      button.setAttribute('aria-pressed', String(site === this.selected));
      button.addEventListener('click', () => {
        this.get('list').querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
        button.setAttribute('aria-pressed', 'true');
        this.details(site);
      });
      return button;
    });
    this.get('list').replaceChildren(...buttons);
    this.get('status').textContent = siteDataStatus(this.loading, matches.length, query, this.partial);
  }

  async refresh() {
    const version = ++this.generation;
    this.loading = true;
    this.partial = false;
    this.sites = [];
    this.get('notice').textContent = '';
    this.get('refresh').disabled = true;
    this.render();
    try {
      const result = await window.aiFree.browser.getSiteData({ historyId: this.historyId });
      if (version !== this.generation) return;
      if (!result.ok) throw new Error(result.error?.message || '读取失败，请重试');
      this.sites = result.data.sites;
      const missing = result.data.unavailable;
      this.partial = Boolean(missing.length);
      this.preferencesUnavailable = missing.includes('网站偏好');
      if (this.partial) this.get('notice').textContent = `${missing.join('、')}索引暂不可读。可关闭该浏览器后刷新。`;
    } catch (error) {
      if (version !== this.generation) return;
      this.partial = true;
      this.get('notice').textContent = error.message || '读取失败，请重试';
    } finally {
      if (version === this.generation) {
        this.loading = false;
        this.get('refresh').disabled = false;
        this.render();
      }
    }
  }

  reset() {
    this.transfer.reset();
    this.generation++;
    this.sites = [];
    this.selected = null;
    this.historyId = '';
  }

  bind() {
    document.getElementById('browser-history-list').addEventListener('click', (event) => {
      const trigger = event.target.closest('.browser-history-sites');
      if (!trigger) return;
      const row = trigger.closest('[data-history-id]');
      this.historyId = row.dataset.historyId;
      this.get('profile').textContent = row.querySelector('.browser-history-name').textContent;
      this.search.value = '';
      const historyId = this.historyId;
      if (!homeDialogs.open(this.dialog, {
        onClose: () => this.reset(),
        resolveFocus: () => document.querySelector(`#browser-history-list [data-history-id="${CSS.escape(historyId)}"] .browser-history-sites`),
      })) return;
      void this.refresh();
    });
    this.dialog.addEventListener('close', () => {
      if (this.dialog.open) return;
      const row = document.querySelector(`#browser-history-list [data-history-id="${CSS.escape(this.historyId)}"]`);
      if (document.activeElement === document.body) row?.querySelector('.browser-history-sites')?.focus();
      this.transfer.reset();
      this.generation++;
      this.sites = [];
      this.selected = null;
      this.historyId = '';
    });
    this.transfer.bind();
    this.search.addEventListener('input', () => this.render());
    this.get('refresh').addEventListener('click', () => this.refresh());
    this.get('copy').addEventListener('click', async () => {
      if (!this.selected) return;
      const version = this.generation;
      const site = this.selected;
      try {
        await navigator.clipboard.writeText(JSON.stringify(site, null, 2));
        if (version === this.generation) this.get('notice').textContent = `已复制 ${site.host} 的统计摘要`;
      } catch {
        if (version === this.generation) this.get('notice').textContent = '剪贴板写入失败，请重试';
      }
    });
  }
}

function siteDataStatus(loading, count, query, partial) {
  if (loading) return '正在读取本地索引…';
  if (count) return `${count} 个网站`;
  if (query) return '没有匹配的域名';
  return partial ? '网站索引读取不完整' : '本地索引中暂无网站';
}

function bindSiteData() { new SiteDataPanel().bind(); }

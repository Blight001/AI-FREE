'use strict';

class AiFreeBrowserHistoryView {
constructor({
  el,
  getBrowserHistory,
  getBrowserProfileAudit,
  openBrowserHistory,
  selectBrowserHistory,
}) {
    Object.assign(this, { el, getBrowserHistory, getBrowserProfileAudit, openBrowserHistory, selectBrowserHistory });
    for (const name of [
      'renderBrowserHistory', 'renderHistoryFailure', 'renderBrowserProfileAudit', 'formatBrowserHistoryDateTime',
    ]) this[name] = this[name].bind(this);
  }

  appendAccountMetadata(main, item) {
    const parts = [];
    if (item.accountDisplayName) parts.push(`账号：${item.accountDisplayName}`);
    if (item.accountTypeLabel) parts.push(item.accountTypeLabel);
    if (parts.length) {
      const accountMeta = document.createElement('span');
      accountMeta.className = 'browser-history-account-meta';
      accountMeta.textContent = parts.join(' · ');
      main.append(accountMeta);
    }
    if (item.accountType === 'shared') {
      const autoDelete = document.createElement('span');
      autoDelete.className = 'browser-history-account-meta browser-history-auto-delete';
      autoDelete.textContent = `自动删除：${this.formatBrowserHistoryDateTime(item.autoDeleteAt) || '等待服务器同步'}`;
      main.append(autoDelete);
    }
  }

  renderRelatedList(id, entries, emptyText, renderEntry) {
    const list = this.el(id);
    if (!list) return;
    if (entries.length) {
      list.replaceChildren(...entries.map(renderEntry));
      return;
    }
    const empty = document.createElement('div');
    empty.className = 'shell-home-record-empty';
    empty.textContent = emptyText;
    list.replaceChildren(empty);
  }

  renderRecord(title, subtitle, action, onClick) {
    const row = document.createElement('div');
    row.className = 'shell-home-record-row';
    const label = document.createElement('div');
    label.className = 'shell-home-record-label';
    const heading = document.createElement('strong');
    heading.textContent = title;
    label.append(heading);
    if (subtitle) {
      const detail = document.createElement('small');
      detail.textContent = subtitle;
      label.append(detail);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'browser-history-action';
    button.textContent = action;
    button.setAttribute('aria-label', `${action}：${title}`);
    button.addEventListener('click', () => void onClick(button));
    row.append(label, button);
    return row;
  }

  renderRelatedLists(history, failed = false) {
    const accounts = history.filter((item) => item.accountDisplayName);
    this.renderRelatedList('home-account-list', accounts, failed ? '关联账号读取失败' : '暂无关联的浏览器账号',
      (item) => this.renderRecord(item.accountDisplayName,
        [item.name, item.accountTypeLabel].filter(Boolean).join(' · '), '打开浏览器',
        (button) => this.openBrowserHistory(item.id, button)));
    this.renderRelatedList('home-cookie-list', history, failed ? '浏览器记录读取失败' : '暂无浏览器记录',
      (item) => this.renderRecord(item.name || '未命名浏览器', item.accountDisplayName, '编辑 Cookie',
        () => this.selectBrowserHistory(item.id, { openDialog: true, focusId: 'browser-cookies' })));
  }

  renderHistoryFailure() {
    this.renderRelatedLists([], true);
    const list = this.el('browser-history-list');
    if (list) list.innerHTML = '<div class="browser-history-empty">浏览器记录读取失败</div>';
  }

  renderBrowserHistory() {
    this.renderRelatedLists(this.getBrowserHistory());
    const list = this.el('browser-history-list');
    if (!list) return;
    list.replaceChildren();
    if (!this.getBrowserHistory().length) {
      const empty = document.createElement('div');
      empty.className = 'browser-history-empty';
      empty.textContent = '暂无浏览器记录，点击窗口栏的“+”新建。';
      list.appendChild(empty);
      return;
    }
    this.getBrowserHistory().forEach((item) => {
      const row = document.createElement('div');
      row.className = 'browser-history-item';
      row.classList.toggle('is-open', item.isOpen === true);
      row.classList.toggle('is-active', item.isActive === true);
      row.classList.toggle('has-error', !!item.lastError);
      row.dataset.historyId = item.id;
  
      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'browser-history-main';
      main.title = `${item.name || '未命名浏览器'}（单击打开）`;
      main.setAttribute('aria-label', `${item.name || '未命名浏览器'}，${item.isActive ? '当前浏览器' : (item.isOpen ? '已打开' : '已关闭')}，单击打开`);
      const nameRow = document.createElement('span');
      nameRow.className = 'browser-history-name-row';
      const icon = document.createElement('span');
      icon.className = 'browser-history-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 3.5h7.2L19 8.3V20.5H7z"></path><path d="M14.2 3.5V8.3H19"></path></svg>';
      const image = document.createElement('img');
      image.alt = '';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('load', () => icon.classList.add('has-site-icon'));
      image.addEventListener('error', () => {
        image.removeAttribute('src');
        icon.classList.remove('has-site-icon');
      });
      const iconUrl = String(item.iconUrl || '').trim();
      if (iconUrl) image.src = iconUrl;
      icon.append(image);
      nameRow.append(icon);
      const name = document.createElement('span');
      name.className = 'browser-history-name';
      name.textContent = item.name || '未命名浏览器';
      nameRow.append(name);
      main.append(nameRow);
      this.appendAccountMetadata(main, item);
      main.addEventListener('click', () => void this.openBrowserHistory(item.id, main));
  
      const actions = document.createElement('div');
      actions.className = 'browser-history-actions';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'browser-history-action browser-history-edit';
      edit.textContent = '编辑';
      edit.title = '编辑名称、参数或删除浏览器';
      edit.addEventListener('click', () => void this.selectBrowserHistory(item.id, { openDialog: true }));
      actions.append(edit);
      row.append(main, actions);
      list.appendChild(row);
    });
  }
  
  renderBrowserProfileAudit() {
    const audit = this.el('browser-profile-audit');
    const totalCount = Number(this.getBrowserProfileAudit()?.totalCount || 0);
    if (audit) {
      audit.hidden = !this.getBrowserProfileAudit();
      audit.textContent = this.getBrowserProfileAudit()
        ? `环境 ${totalCount}`
        : '';
    }
  }
  
  formatBrowserHistoryDateTime(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (part) => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
}

window.createAiFreeBrowserHistoryView = function createAiFreeBrowserHistoryView(dependencies) {
  return new AiFreeBrowserHistoryView(dependencies);
};

'use strict';

class AiFreeBrowserHistoryView {
constructor({
  el,
  getBrowserHistory,
  openBrowserHistory,
  selectBrowserHistory,
}) {
    Object.assign(this, { el, getBrowserHistory, openBrowserHistory, selectBrowserHistory });
    for (const name of [
      'renderBrowserHistory', 'renderHistoryFailure', 'formatBrowserHistoryDateTime',
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

  renderHistoryFailure() {
    const list = this.el('browser-history-list');
    if (list) list.innerHTML = '<div class="browser-history-empty">浏览器记录读取失败</div>';
  }

  getHistoryStatus(item) {
    if (item.lastError) return '异常';
    if (item.isActive) return '当前浏览器';
    if (item.isOpen) return '运行中';
    return '';
  }

  createHistoryActions(historyId, name) {
    const actions = document.createElement('div');
    actions.className = 'browser-history-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'browser-history-action browser-history-edit';
    edit.textContent = '编辑';
    edit.title = '编辑名称、参数或删除浏览器';
    edit.addEventListener('click', () => void this.selectBrowserHistory(historyId, { openDialog: true }));
    const sites = document.createElement('button');
    sites.type = 'button';
    sites.className = 'browser-history-action browser-history-sites';
    sites.textContent = '网站数据';
    sites.setAttribute('aria-haspopup', 'dialog');
    sites.setAttribute('aria-label', `网站数据：${name}`);
    actions.append(sites, edit);
    return actions;
  }

  renderBrowserHistory() {
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
      const statusLabel = this.getHistoryStatus(item);
      main.setAttribute('aria-label', `${item.name || '未命名浏览器'}，${statusLabel || '已关闭'}，单击打开`);
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
      if (statusLabel) {
        const status = document.createElement('span');
        status.className = 'browser-history-status';
        status.textContent = statusLabel;
        nameRow.append(status);
      }
      main.append(nameRow);
      this.appendAccountMetadata(main, item);
      main.addEventListener('click', () => void this.openBrowserHistory(item.id, main));
  
      row.append(main, this.createHistoryActions(item.id, name.textContent));
      list.appendChild(row);
    });
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

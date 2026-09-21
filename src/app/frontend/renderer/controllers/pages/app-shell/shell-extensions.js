(function initExtensionManagerView() {
  const el = (id) => document.getElementById(id);
  let state = { plugins: [] };
  let busy = false;
  const openDetailIds = new Set();

  function status(message, type = '') {
    const target = el('extension-manager-status');
    if (!target) return;
    target.textContent = String(message || '');
    target.dataset.type = type;
  }

  function button(label, className, handler, disabled = false) {
    const target = document.createElement('button');
    target.type = 'button'; target.className = className; target.textContent = label;
    target.disabled = disabled; target.addEventListener('click', handler);
    return target;
  }

  function pluginIntro(plugin) {
    if (plugin.missing === true) return '插件目录不存在，请重新导入';
    return String(plugin.hint || plugin.description || `版本 ${plugin.version || '未知'}`).trim();
  }

  function pluginDetails(plugin) {
    if (plugin.missing === true) return '';
    const description = String(plugin.description || '').trim();
    const hint = String(plugin.hint || '').trim();
    const lines = [];
    if (description) lines.push(description);
    if (hint && hint !== description) lines.push(hint);
    if (plugin.version) lines.push(`版本 ${plugin.version}`);
    return lines.join('\n');
  }

  function pluginDetailId(plugin) {
    const safeId = String(plugin.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
    return safeId ? `extension-plugin-detail-${safeId}` : '';
  }

  function applyDetailsOpen(pluginId, detailsBtn, detailsBody, open) {
    if (!detailsBtn || !detailsBody) return;
    detailsBody.hidden = !open;
    detailsBtn.textContent = open ? '收起' : '详情';
    detailsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) openDetailIds.add(pluginId);
    else openDetailIds.delete(pluginId);
  }

  function render() {
    const list = el('extension-plugin-list');
    if (!list) return;
    list.replaceChildren();
    const plugins = Array.isArray(state.plugins) ? state.plugins : [];
    if (!plugins.length) {
      const empty = document.createElement('div');
      empty.className = 'extension-plugin-empty';
      empty.textContent = '暂无统一插件，点击“手动导入插件”添加解压后的插件目录。';
      list.append(empty);
      return;
    }
    plugins.forEach((plugin) => {
      const row = document.createElement('div');
      row.className = 'extension-plugin-item';
      row.classList.toggle('is-disabled', plugin.enabled !== true || plugin.missing === true);
      if (plugin.iconDataUrl) {
        const icon = document.createElement('img'); icon.className = 'extension-plugin-icon';
        icon.src = plugin.iconDataUrl; icon.alt = ''; row.append(icon);
      }
      const main = document.createElement('div'); main.className = 'extension-plugin-main';
      const name = document.createElement('strong'); name.textContent = plugin.name || '未命名插件';
      const intro = document.createElement('div'); intro.className = 'extension-plugin-intro';
      const summary = document.createElement('span');
      summary.className = 'extension-plugin-summary';
      summary.textContent = pluginIntro(plugin);
      intro.append(summary);
      const detailsText = pluginDetails(plugin);
      let detailsBtn = null;
      const detailsBody = document.createElement('p');
      detailsBody.className = 'extension-plugin-detail-body';
      const detailId = pluginDetailId(plugin);
      if (detailId) detailsBody.id = detailId;
      detailsBody.textContent = detailsText;
      if (detailsText) {
        detailsBtn = button('详情', 'extension-plugin-details', () => {
          applyDetailsOpen(plugin.id, detailsBtn, detailsBody, detailsBody.hidden);
        });
        if (detailId) detailsBtn.setAttribute('aria-controls', detailId);
        applyDetailsOpen(plugin.id, detailsBtn, detailsBody, openDetailIds.has(plugin.id));
        intro.append(detailsBtn);
      } else {
        detailsBody.hidden = true;
      }
      main.append(name, intro);
      const actions = document.createElement('div'); actions.className = 'extension-plugin-actions';
      const toggle = button(plugin.enabled === true ? '已启用' : '已停用', 'extension-plugin-toggle', () => void setEnabled(plugin), busy || plugin.missing === true);
      toggle.classList.toggle('is-enabled', plugin.enabled === true);
      actions.append(toggle);
      if (!plugin.builtin) actions.append(button('删除', 'extension-plugin-remove', () => void removePlugin(plugin), busy));
      row.append(main);
      if (detailsText) row.append(detailsBody);
      row.append(actions);
      list.append(row);
    });
  }

  function readState(response) {
    if (response?.state) state = response.state;
    render();
  }

  async function refresh() {
    const api = window.aiFree?.extensions;
    if (!api?.getState || !el('extension-plugin-list')) return;
    try { readState(await api.getState()); } catch (error) { status(error?.message || String(error), 'error'); }
  }

  async function runAction(action, success) {
    if (busy) return;
    busy = true; render(); status('正在更新统一插件…');
    try {
      const response = await action();
      if (!response?.ok) throw new Error(response?.message || response?.error || '插件操作失败');
      readState(response); status(success, 'success');
    } catch (error) { status(error?.message || String(error), 'error'); }
    finally { busy = false; render(); }
  }

  function setEnabled(plugin) {
    return runAction(() => window.aiFree.extensions.setEnabled({ id: plugin.id, enabled: plugin.enabled !== true }), plugin.enabled === true ? '已停用统一插件。' : '已启用到全部浏览器。');
  }

  function removePlugin(plugin) {
    if (!window.confirm(`确认删除统一插件“${plugin.name || '未命名插件'}”？`)) return Promise.resolve();
    return runAction(() => window.aiFree.extensions.removePlugin({ id: plugin.id }), '统一插件已删除。');
  }

  async function importPlugin() {
    await runAction(() => window.aiFree.extensions.importPlugin(), '插件已导入并启用到全部浏览器。');
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!el('extension-plugin-list')) return;
    el('import-extension-plugin')?.addEventListener('click', () => void importPlugin());
    const subscribe = window.aiFree?.extensions?.onStateChanged;
    if (typeof subscribe === 'function') subscribe((next) => { state = next || state; render(); });
    void refresh();
  });
}());

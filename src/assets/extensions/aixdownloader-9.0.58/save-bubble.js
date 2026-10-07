(() => {
  'use strict';
  if (globalThis.icSaveBubbleInstalled) return;
  globalThis.icSaveBubbleInstalled = true;
  let active = null;
  let anchor = null;
  document.addEventListener('contextmenu', event => {
    if (!active?.host.contains(event.target)) anchor = { x: event.clientX, y: event.clientY };
  }, true);
  const icons = {
    photo: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 6-5 4 4 3-3 3 3"/>',
    prompt: '<path d="M5 5h14M12 5v14M8 19h8"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/>'
  };
  const svg = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
  function node(tag, attrs = {}, text) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
    if (text != null) element.textContent = text;
    return element;
  }
  function call(state, action, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ channel: 'ic-save', action, captureId: state.capture.id, payload }, response => {
        if (chrome.runtime.lastError) return reject(new Error('插件已更新，请刷新网页后重试。'));
        if (!response?.ok) return reject(new Error(response?.error || '连接中断，请重试。'));
        resolve(response.data);
      });
    });
  }
  function status(state, message, kind = '') {
    state.q('#status').textContent = message;
    state.q('#status').className = `status ${kind}`;
    place(state);
  }
  function close(state) {
    if (state.busy) return;
    state.abort.abort();
    state.host.remove();
    if (active === state) active = null;
    if (state.previousFocus?.isConnected) state.previousFocus.focus({ preventScroll: true });
  }
  function place(state) {
    if (!state.host.isConnected) return;
    const card = state.q('.card');
    const width = card.getBoundingClientRect().width;
    const height = card.getBoundingClientRect().height;
    const point = state.anchor || { x: innerWidth - width - 24, y: 80 };
    let left = point.x + 12;
    if (left + width > innerWidth - 12) left = point.x - width - 12;
    left = Math.max(12, Math.min(left, innerWidth - width - 12));
    const belowTop = point.y + 10;
    const aboveTop = point.y - height - 10;
    const above = belowTop + height > innerHeight - 12 && aboveTop >= 12;
    const top = above ? aboveTop : Math.max(12, Math.min(belowTop, innerHeight - height - 12));
    card.classList.toggle('above', above);
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
    card.style.setProperty('--arrow-left', `${Math.max(24, Math.min(width - 24, point.x - left))}px`);
  }
  function tokenTheme(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return '';
    if (/^(dark|night|black|dim|深色|暗色|夜间)$/.test(text) || /(^|[-_ ])(dark|night|dim)([-_ ]|$)/.test(text)) return 'dark';
    if (/^(light|day|白色|浅色|明亮)$/.test(text) || /(^|[-_ ])(light|day)([-_ ]|$)/.test(text)) return 'light';
    return '';
  }
  function cssColorTheme(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text || text === 'transparent' || text === 'inherit' || text === 'initial') return '';
    const match = text.match(/rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/);
    if (!match) return '';
    const rgb = match.slice(1, 4).map(Number).map(channel => channel > 1 ? channel / 255 : channel);
    const luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    return luminance < 0.42 ? 'dark' : luminance > 0.68 ? 'light' : '';
  }
  function detectPageTheme() {
    const roots = [document.documentElement, document.body].filter(Boolean);
    for (const root of roots) {
      const attrs = ['data-theme', 'data-color-mode', 'data-mode', 'theme', 'color-scheme'];
      for (const attr of attrs) {
        const result = tokenTheme(root.getAttribute?.(attr));
        if (result) return result;
      }
      const result = tokenTheme(typeof root.className === 'string' ? root.className : root.getAttribute?.('class'));
      if (result) return result;
    }
    for (const root of roots) {
      try {
        const styles = getComputedStyle(root);
        const colorScheme = String(styles.colorScheme || '').trim().toLowerCase();
        if (colorScheme === 'dark' || colorScheme === 'light') return colorScheme;
        const result = cssColorTheme(styles.backgroundColor);
        if (result) return result;
      } catch (_) {}
    }
    try { return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (_) { return 'light'; }
  }
  function theme(state, value) {
    state.themePreference = value === 'dark' || value === 'light' ? value : 'system';
    state.pageTheme = detectPageTheme();
    const selected = state.themePreference === 'system' ? state.pageTheme : state.themePreference;
    state.host.classList.toggle('dark', selected === 'dark');
    state.host.dataset.theme = selected;
  }
  function watchPageTheme(state) {
    const refresh = () => {
      if (active !== state || state.themePreference !== 'system') return;
      const next = detectPageTheme();
      if (next !== state.pageTheme) theme(state, 'system');
    };
    state.pageThemeObserver = new MutationObserver(refresh);
    for (const root of [document.documentElement, document.body].filter(Boolean)) {
      state.pageThemeObserver.observe(root, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode', 'data-mode', 'theme', 'color-scheme'] });
    }
    state.mediaTheme = matchMedia('(prefers-color-scheme: dark)');
    state.mediaTheme.addEventListener?.('change', refresh);
    state.pageThemeTimer = setInterval(refresh, 750);
    state.abort.signal.addEventListener('abort', () => {
      state.pageThemeObserver?.disconnect();
      state.mediaTheme?.removeEventListener?.('change', refresh);
      clearInterval(state.pageThemeTimer);
    }, { once: true });
  }
  function scaffold(state) {
    state.host = node('div', { id: 'ic-save-bubble-host' });
    state.host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;';
    state.root = state.host.attachShadow({ mode: 'open' });
    state.q = selector => state.root.querySelector(selector);
    // Only fixed extension markup is assigned as HTML. All webpage values use textContent/value.
    state.root.innerHTML = `<style>${globalThis.IcSaveBubbleStyle}</style>
      <section class="card" role="dialog" aria-modal="false" aria-labelledby="save-title" tabindex="-1">
        <header class="head"><span class="brand">${svg(state.prompt ? 'prompt' : 'photo')}</span>
          <div class="heading"><div class="eyebrow">INFINITE CANVAS</div><h2 id="save-title"></h2></div>
          <button class="icon" id="settings-toggle" aria-label="连接设置" title="连接设置">${svg('settings')}</button>
          <button class="icon" id="close" aria-label="关闭" title="关闭">${svg('close')}</button></header>
        <div class="body"><div class="source"><div class="preview"></div><div class="source-copy"><span id="media-kind"></span><strong id="source-name"></strong><span id="source-site"></span></div></div>
          <section class="connection" hidden><div class="section-label">连接设置</div><label for="server">服务器地址</label><input id="server" type="url" placeholder="http://127.0.0.1:58112" spellcheck="false">
            <div class="connection-row"><select id="theme" aria-label="外观"><option value="system">跟随网页</option><option value="light">浅色</option><option value="dark">深色</option></select><button id="connect" class="button">连接并保存</button></div>
          </section>
          <form id="save-form"><div class="section-label">保存位置</div><div class="grid"><label>素材库<select id="library" required></select></label><label>保存类目<select id="category" required></select></label></div>
            <div class="destination">${svg('folder')}<span id="destination">正在读取保存位置…</span></div>
            <label class="field"><span id="name-label">素材名称</span><input id="name" maxlength="120" required placeholder="为素材命名"></label>
            <div id="prompt-fields" hidden><label class="field">正向提示词 <textarea id="positive" rows="4" placeholder="写下或粘贴提示词…"></textarea></label>
              <details><summary>更多信息 <span>可选</span></summary><label class="field">反向提示词<textarea id="negative" rows="2" placeholder="希望避免的内容"></textarea></label><label class="field">用途说明<input id="scene" maxlength="500" placeholder="例如：人物摄影、海报设计"></label></details>
              <label class="check" id="reference-row"><input id="reference" type="checkbox" checked>将当前图片作为参考图</label>
            </div><label class="check" id="download-row"><input id="download" type="checkbox">同时下载原文件</label>
          </form></div>
        <footer><div class="status" id="status" role="status" aria-live="polite">正在连接素材库…</div><div class="actions"><button id="cancel" class="button">取消</button><button id="retry" class="button" hidden>重新连接</button><button id="save" form="save-form" type="submit" class="button primary" disabled>确认保存</button></div></footer>
      </section>`;
    document.documentElement.append(state.host);
    state.q('#save-title').textContent = state.prompt ? '保存到提示词库' : '保存到照片资产';
    state.q('#name-label').textContent = state.prompt ? '提示词名称' : '素材名称';
    state.q('#name').value = state.capture.sourceName || (state.prompt ? '网页提示词' : '网页素材');
    state.q('#positive').value = state.capture.selectionText || '';
    state.q('#positive').required = state.prompt;
    state.q('#prompt-fields').hidden = !state.prompt;
    state.q('#reference-row').hidden = !state.capture.sourceUrl || state.capture.mediaType !== 'image';
    state.q('#reference').checked = !state.q('#reference-row').hidden;
    state.q('#download-row').hidden = !state.capture.sourceUrl;
    state.q('#server').value = 'http://127.0.0.1:58112';
    renderSource(state);
    theme(state, 'system');
  }
  function renderSource(state) {
    const capture = state.capture;
    const kind = capture.mediaType || 'image';
    const names = { image: '图片', video: '视频', audio: '音频' };
    state.q('#media-kind').textContent = capture.sourceUrl ? names[kind] || '媒体' : '选中文字';
    state.q('#source-name').textContent = capture.sourceName || capture.pageTitle || '网页素材';
    try { state.q('#source-site').textContent = new URL(capture.pageUrl).hostname; } catch (_) { state.q('#source-site').textContent = '当前网页'; }
    const preview = state.q('.preview');
    preview.innerHTML = svg(state.prompt ? 'prompt' : 'photo');
    if (capture.sourceUrl && kind === 'image' && /^(https?:|data:image\/|blob:)/i.test(capture.sourceUrl)) {
      const image = node('img', { alt: '当前素材预览' });
      image.addEventListener('error', () => image.remove(), { once: true });
      image.src = capture.sourceUrl;
      preview.append(image);
    } else if (kind === 'video' || kind === 'audio') preview.textContent = kind === 'video' ? '▶' : '♫';
  }
  function categories(state) {
    const library = state.libraries.find(item => item.id === state.q('#library').value);
    const result = [];
    function walk(items, parent = '') {
      for (const item of items || []) {
        if (item.type === 'workflow') continue;
        const name = parent + (item.name || item.id);
        if (state.prompt || ['image', 'video', 'audio'].includes(item.type || 'image')) result.push({ ...item, name });
        walk(item.children, name + ' / ');
      }
    }
    walk(library?.categories);
    if (state.prompt && !result.length && library) return [{ id: 'custom', name: '自定义' }];
    return result;
  }
  function fill(select, items, preferred, empty) {
    select.replaceChildren();
    if (!items.length) select.add(new Option(empty, ''));
    else for (const item of items) select.add(new Option(item.name || item.id, item.id));
    if (items.some(item => item.id === preferred)) select.value = preferred;
  }
  function renderCategories(state, preferred = '') {
    fill(state.q('#category'), categories(state), preferred, '暂无可用类目');
    const library = state.q('#library');
    const category = state.q('#category');
    state.q('#save').disabled = state.busy || !library.value || !category.value || state.saved;
    state.q('#destination').textContent = library.value && category.value ? `${library.selectedOptions[0].textContent} / ${category.selectedOptions[0].textContent}` : '请先在素材库中创建保存类目';
    place(state);
  }
  async function load(state, action = 'init', payload = {}) {
    state.q('#retry').hidden = true;
    state.q('#save').disabled = true;
    state.q('#connect').disabled = true;
    status(state, '正在连接素材库…');
    try {
      const data = await call(state, action, payload);
      if (active !== state) return;
      state.libraries = (state.prompt ? data.promptLibraries : data.assetLibraries) || data.library?.libraries || [];
      const settings = data.settings || {};
      state.q('#server').value = settings.serverUrl || 'http://127.0.0.1:58112';
      state.q('#theme').value = settings.theme || 'system';
      theme(state, settings.theme);
      const prefix = state.prompt ? 'prompt' : 'asset';
      fill(state.q('#library'), state.libraries, settings[prefix + 'LibraryId'] || (state.prompt ? data.activePromptLibraryId : data.activeAssetLibraryId), '暂无可用素材库');
      renderCategories(state, settings[prefix + 'CategoryId']);
      if (action === 'settings') state.q('.connection').hidden = true;
      status(state, state.libraries.length ? '选择类目后即可保存' : '没有可写的素材库，请先在网站创建。');
    } catch (error) {
      if (active !== state) return;
      state.q('#retry').hidden = false;
      state.q('.connection').hidden = false;
      status(state, error.message, 'error');
    } finally { state.q('#connect').disabled = false; place(state); }
  }
  async function submit(state, event) {
    event.preventDefault();
    if (state.busy || state.saved) return;
    const value = id => state.q('#' + id).value.trim();
    if (!value('library') || !value('category')) return status(state, '请选择素材库和保存类目', 'error');
    const payload = { target: state.capture.mode, libraryId: value('library'), categoryId: value('category'), name: value('name'), positive: value('positive'), negative: value('negative'), scene: value('scene'), includeReference: state.q('#reference').checked, download: state.q('#download').checked };
    state.busy = true;
    const controls = [...state.root.querySelectorAll('input,select,textarea,button')];
    controls.forEach(control => { control.disabled = true; });
    status(state, '正在上传并保存，请稍候…');
    try {
      const result = await call(state, 'save', payload);
      if (active !== state) return;
      state.saved = true;
      status(state, result.warning ? `已保存。${result.warning}` : `已保存到 ${state.q('#destination').textContent}`, result.warning ? '' : 'ok');
      state.q('#save').innerHTML = svg('check') + ' 已保存';
      state.q('#cancel').textContent = '完成';
    } catch (error) {
      controls.forEach(control => { control.disabled = false; });
      status(state, error.message, 'error');
    } finally {
      state.busy = false;
      state.q('#cancel').disabled = false;
      state.q('#close').disabled = false;
    }
  }
  function bind(state) {
    const signal = state.abort.signal;
    state.q('#close').onclick = state.q('#cancel').onclick = () => close(state);
    state.q('#settings-toggle').onclick = () => { state.q('.connection').hidden = !state.q('.connection').hidden; place(state); };
    state.q('#connect').onclick = () => load(state, 'settings', { serverUrl: state.q('#server').value.trim(), theme: state.q('#theme').value });
    state.q('#theme').onchange = () => theme(state, state.q('#theme').value);
    state.q('#retry').onclick = () => load(state);
    state.q('#library').onchange = () => renderCategories(state);
    state.q('#category').onchange = () => renderCategories(state, state.q('#category').value);
    state.q('#save-form').onsubmit = event => submit(state, event);
    state.q('details').addEventListener('toggle', () => place(state), { signal });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); close(state); }
    }, { capture: true, signal });
    window.addEventListener('resize', () => place(state), { signal });
    if (typeof ResizeObserver === 'function') {
      state.resizeObserver = new ResizeObserver(() => place(state));
      state.resizeObserver.observe(state.q('.card'));
      signal.addEventListener('abort', () => state.resizeObserver?.disconnect(), { once: true });
    }
  }
  function open(capture) {
    if (active?.busy) return;
    if (active) close(active);
    const state = { capture, prompt: capture.mode === 'prompt', libraries: [], abort: new AbortController(), anchor, previousFocus: document.activeElement, busy: false, saved: false };
    active = state;
    scaffold(state);
    bind(state);
    place(state);
    state.q('.card').focus({ preventScroll: true });
    void load(state);
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.channel !== 'ic-save' || message.action !== 'open') return;
    open(message.capture);
    respond({ ok: true });
  });
})();





